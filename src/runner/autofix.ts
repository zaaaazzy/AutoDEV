import { logged } from '../core/log.js';
import {
  EXTERNAL_TEXT_END,
  EXTERNAL_TEXT_START,
  UNTRUSTED_BUG_SOURCES_SQL,
  unapprovedBugSql,
} from '../core/bug-trust.js';
import { folderAvailable } from '../core/folder-guard.js';
import { summarizeTestFailure } from '../core/test-results.js';
import { humanActionFor, setActionTodo } from './action-todo.js';
import { DEVELOPMENT_STATUS } from '../core/status.js';
import { shortTitle } from '../core/validation.js';
import type { Pool } from 'pg';
import { reportAgentBug } from '../api/bugs.js';
import { UNTRUSTED_START } from './hoster.js';

const MAX_AUTO_RETRIES = 2;

interface FailedItem {
  id: string;
  projectSlug: string;
  title: string;
  kind?: string;
  bugId?: string | null;
  sprintId?: string | null;
}

/** Nutzungslimit des Agent-Kontos (Claude-CLI): „You've hit your session limit · resets 12:40am (Europe/Zurich)“. */
const USAGE_LIMIT = /hit your (?:session|usage|weekly|daily|monthly|\w+) limit/i;
const LIMIT_RESET =
  /resets?\s+(?:(?:on\s+)?([A-Z][a-z]{2})\s+(\d{1,2}),?\s+)?(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * Fehler des Agents selbst (Zeitlimit, Schleife, Modell nicht erreichbar, Befehl fehlt …) sind keine Fehler im Code.
 * Ein Bug-Auftrag dafür kann nichts beheben und würde nur weitere Fehlschläge und Prompt-Ballast erzeugen.
 */
const AGENT_FAILURE_PATTERNS = [
  /Zeitlimit erreicht/,
  /Schleife erkannt/,
  /wiederholt mit denselben Argumenten/,
  /Maximale Anzahl von \d+ Schritten erreicht/,
  /Der Entwickler-Agent hat keine Dateien geändert/,
  /Ollama nicht erreichbar/,
  /Ollama antwortete mit \d+/,
  /Ollama lieferte keine Nachricht/,
  /Das Modell lieferte keine Antwort/,
  /im PATH des Workers nicht gefunden/,
  // Nur der Agent-Befehl selbst fehlt („spawn claude ENOENT“); ein ENOENT in einem Test (fehlendes Fixture) ist ein
  // normaler Fehler mit Bug-Bericht.
  /\bspawn \S+ ENOENT\b/,
  /Process ended by SIG\w+ \(timeout or kill\)/,
  /Unterbrochen: Der Worker wurde beendet/,
  USAGE_LIMIT,
];

/**
 * Nutzungslimit des Agent-Kontos erreicht: kein Fehler im Code und nichts, was eine Wiederholung in Minuten löst.
 * Liefert den Zeitpunkt, ab dem der Auftrag wieder starten darf (Reset laut Meldung plus kleine Reserve, in der
 * Zeitzone des Workers); ohne lesbare Zeit eine Stunde später. Null, wenn die Ausgabe kein Limit meldet.
 */
export function usageLimitReset(output: string, now = new Date()): Date | null {
  const tail = output.slice(-3000);
  if (!USAGE_LIMIT.test(tail)) return null;
  const match = tail.match(LIMIT_RESET);
  if (!match) return new Date(now.getTime() + 60 * 60_000);
  const [, month, day, hour, minute, meridiem] = match;
  const hours = (Number(hour) % 12) + (meridiem!.toLowerCase() === 'pm' ? 12 : 0);
  const reset = new Date(now);
  reset.setHours(hours, Number(minute ?? 0), 0, 0);
  const monthIndex = month ? MONTHS.indexOf(month.toLowerCase()) : -1;
  if (monthIndex >= 0 && day) {
    reset.setMonth(monthIndex, Number(day));
    if (reset.getTime() <= now.getTime()) reset.setFullYear(reset.getFullYear() + 1);
  } else if (reset.getTime() <= now.getTime()) {
    reset.setDate(reset.getDate() + 1);
  }
  return new Date(reset.getTime() + 3 * 60_000);
}

/**
 * Vorübergehende Fehler: Modell oder Dienst kurz nicht erreichbar, überlastet, Verbindung abgebrochen, Zeitlimit.
 * Solche Schritte werden einmal nach kurzer Pause wiederholt, bevor der Auftrag blockiert.
 */
const TRANSIENT_PATTERNS = [
  /Ollama nicht erreichbar/,
  /Ollama antwortete mit (?:429|5\d\d)/,
  /Ollama lieferte keine Nachricht/,
  /Das Modell lieferte keine Antwort/,
  /Zeitlimit erreicht/,
  /Process ended by SIG\w+ \(timeout or kill\)/,
  /\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up)\b/,
  /\boverloaded(?:_error)?\b/i,
  /\brate[ _-]?limit/i,
  /API Error:? (?:429|5\d\d)\b/i,
  /\b(?:502 Bad Gateway|503 Service Unavailable|529)\b/,
];

export function isTransientFailure(output: string): boolean {
  const tail = output.slice(-1500);
  return TRANSIENT_PATTERNS.some((pattern) => pattern.test(tail));
}

export function isAgentFailure(output: string): boolean {
  const tail = output.slice(-1500);
  return AGENT_FAILURE_PATTERNS.some((pattern) => pattern.test(tail));
}

/**
 * Projektordner bzw. Laufwerk war nicht erreichbar – kein Code-Fehler, der Auftrag startet wieder, sobald er da ist.
 * Nur Meldungen, die das Arbeitsverzeichnis selbst betreffen: ein ENOENT in einem Test (fehlendes Fixture, `scandir`,
 * „Path … does not exist“) ist ein normaler Fehler mit Bug-Bericht – sonst liefe der Auftrag endlos erneut an.
 */
const ENVIRONMENT_PATTERNS = [
  /Can't access working directory/i,
  /Projektordner nicht gefunden/,
  /no such file or directory, (?:chdir|uv_cwd)\b/i,
];
export const ENVIRONMENT_TODO =
  'Projektordner bzw. Laufwerk nicht erreichbar – anschliessen, der Auftrag startet dann neu';

/** Ein Agent hat wegen einer Projektregel (Do's and Don'ts) abgelehnt: „@@REGEL: <Regel>“. */
export function ruleRefusal(output: string): string | null {
  return output.match(/^\s*@@REGEL:\s*(.+)$/m)?.[1]?.trim() || null;
}

export function isEnvironmentFailure(output: string): boolean {
  const tail = output.slice(-3000);
  return ENVIRONMENT_PATTERNS.some((pattern) => pattern.test(tail));
}

/**
 * Hält den Fehler am Auftrag fest, legt einen Bug-Bericht an und – bei aktivem automatischen Bugfixing –
 * erzeugt sofort einen Behebungsauftrag, der ohne Sprint-Zuweisung vom Worker aufgenommen wird.
 */
/**
 * Testausgaben (TAP) lesbar machen: Zusammenfassung mit Zahlen, fehlgeschlagenen Tests und Hinweis, darunter das Ende
 * der Ausgabe als Codeblock ab einer ganzen Zeile. Andere Ausgaben (z. B. die Antwort eines Agents) bleiben, wie sie sind.
 */
export function failureDetail(output: string): string | null {
  // Abnahme abgelehnt (Tests grün, aber Kriterien nicht erfüllt): Die Gründe stehen am Ende der Ausgabe und müssen
  // lesbar bleiben – keine Testzusammenfassung davor, die „alles bestanden“ meldet und den Grund im Protokoll versteckt.
  if (/^##\s*Abnahme nicht bestanden/m.test(output)) return null;
  const summary = summarizeTestFailure(output.slice(-50_000));
  if (!summary) return null;
  // Keine roten Tests im gesehenen Ausschnitt: Die Zusammenfassung wäre irreführend (oft ein Teil-Lauf mit „1 Tests“).
  if (/·\s*0 fehlgeschlagen/.test(summary)) return null;
  const tail = output.trim().slice(-1500);
  const lines = tail.slice(tail.indexOf('\n') + 1).replaceAll('```', "'''");
  return `${summary}\n\n**Ausgabe (Ende):**\n\n\`\`\`text\n${lines}\n\`\`\``;
}

export async function registerFailure(pool: Pool, item: FailedItem, agentName: string, output: string): Promise<void> {
  const tail = output.trim().slice(-3000) || 'Keine Ausgabe vorhanden.';
  const detail = failureDetail(output) ?? tail;
  // Umgebung (Laufwerk weg) und Projektregeln sind keine Code-Fehler: kein Bug-Auftrag, sondern „Aktion notwendig“.
  const rule = ruleRefusal(output);
  if (rule || isEnvironmentFailure(tail)) {
    const todo = rule
      ? `Projektregel verhindert den Auftrag: ${rule} – Auftrag anpassen oder verwerfen`
      : ENVIRONMENT_TODO;
    // Verstoss gegen eine Projektregel: Status „abgelehnt“ (ein Bug-Auftrag lehnt per Trigger auch den Bug ab).
    await pool.query(
      `UPDATE development_items SET failure = $2, auto_run = FALSE${rule ? `, status = '${DEVELOPMENT_STATUS.rejected}'` : ''} WHERE id = $1`,
      [
        item.id,
        `Agent „${agentName}“ hat angehalten.\n\n**Vermerk:** ${rule ? 'Projektregel' : 'Umgebung'} – ${todo}.\n\n${detail}`,
      ],
    );
    await setActionTodo(pool, item.id, todo.slice(0, 160)).catch(logged('autofix'));
    return;
  }
  // Wartet der Auftrag auf einen Menschen, heisst er „Aktion notwendig“ statt „fehlgeschlagen“.
  const todo = humanActionFor(tail);
  if (todo) await setActionTodo(pool, item.id, todo).catch(logged('autofix'));
  // Fail-closed: ohne Projektzeile kein Auto-Bugfix.
  const auto =
    (
      await pool.query<{ auto: boolean }>('SELECT auto_bugfix AS auto FROM projects WHERE slug = $1', [
        item.projectSlug,
      ])
    ).rows[0]?.auto ?? false;
  if (item.bugId) {
    await pool.query('UPDATE bugs SET fix_notes = $2, updated_at = NOW() WHERE id = $1', [
      item.bugId,
      `Letzter Behebungsversuch scheiterte bei „${agentName}“: ${(summarizeTestFailure(output) ?? tail).slice(-1500)}`,
    ]);
    await pool.query(
      `UPDATE development_items SET failure = $2, failure_bug_id = $3, auto_run = FALSE,
              analysis_status = CASE WHEN $4 AND analysis_status IS NULL THEN 'requested' ELSE analysis_status END
        WHERE id = $1`,
      [item.id, `Agent „${agentName}“ scheiterte:\n\n${detail}`, item.bugId, auto],
    );
    return;
  }
  if (isAgentFailure(tail)) {
    // Kein Bug-Bericht: Auftrag bleibt blockiert, die Problemanalyse schlägt das weitere Vorgehen vor.
    await pool.query(
      `UPDATE development_items SET failure = $2, auto_run = FALSE,
              analysis_status = CASE WHEN analysis_status IS NULL THEN 'requested' ELSE analysis_status END
        WHERE id = $1`,
      [item.id, `Agent „${agentName}“ konnte nicht arbeiten (kein Code-Fehler, daher kein Bug-Auftrag):\n\n${detail}`],
    );
    return;
  }
  const bugId = await reportAgentBug(pool, {
    projectSlug: item.projectSlug,
    // Kurz: Agent und Auftrag; die Fehlerausgabe steht in der Beschreibung.
    title: `${agentName}: ${shortTitle(item.title)}`,
    description: detail,
  });
  // Bevor ein Behebungsauftrag entsteht, prüft die Problemanalyse (ein zweiter Agent), ob die Diagnose stimmt.
  await pool.query(
    `UPDATE development_items SET failure = $2, failure_bug_id = $3, auto_run = FALSE,
            analysis_status = CASE WHEN $4 AND analysis_status IS DISTINCT FROM 'running' THEN 'requested' ELSE analysis_status END
      WHERE id = $1`,
    [item.id, `Agent „${agentName}“ scheiterte:\n\n${detail}`, bugId, auto],
  );
}

/**
 * Nach der Problemanalyse: Bestätigt sie einen Code-Fehler, wird an einen Behebungsauftrag delegiert, sonst
 * wartet der Auftrag auf eine Aktion. Beides wird als Vermerk am Auftrag und am Bug festgehalten.
 */
export async function delegateAfterAnalysis(
  pool: Pool,
  item: FailedItem & { failureBugId: string | null },
  analysis: { title: string; action: string | null | undefined },
): Promise<void> {
  if (!item.failureBugId || item.kind === 'bug') return;
  const human = typeof analysis.action === 'string';
  const note = human
    ? `**Vermerk der Problemanalyse:** kein Code-Fehler – Aktion notwendig: ${analysis.action}. Kein Behebungsauftrag erstellt.`
    : `**Vermerk der Problemanalyse:** Code-Fehler bestätigt („${analysis.title}“) – an einen Behebungsauftrag delegiert.`;
  await pool.query(`UPDATE development_items SET failure = COALESCE(failure, '') || E'\n\n' || $2 WHERE id = $1`, [
    item.id,
    note,
  ]);
  if (human) return;
  await pool.query(`UPDATE bugs SET description = description || E'\n\n' || $2, updated_at = NOW() WHERE id = $1`, [
    item.failureBugId,
    note,
  ]);
  const auto =
    (
      await pool.query<{ auto: boolean }>('SELECT auto_bugfix AS auto FROM projects WHERE slug = $1', [
        item.projectSlug,
      ])
    ).rows[0]?.auto ?? false;
  if (auto) await queueBugFix(pool, item, item.failureBugId);
}

/**
 * Ist der Projektordner wieder erreichbar, starten Aufträge, die nur darauf gewartet haben, erneut – höchstens
 * MAX_AUTO_RETRIES-mal (retry_count), damit ein falsch erkannter Umgebungsfehler keine Endlosschleife auslöst.
 */
export async function resumeAfterEnvironment(pool: Pool, project: string, cwd?: string): Promise<void> {
  if (cwd !== undefined && !folderAvailable(cwd)) return;
  await pool.query(
    `UPDATE development_items SET status = 'planned', auto_run = TRUE, failure = NULL, action_todo = NULL, retry_count = retry_count + 1, updated_at = NOW()
      WHERE project_slug = $1 AND status = 'blocked' AND action_todo = $2 AND retry_count < $3`,
    [project, ENVIRONMENT_TODO, MAX_AUTO_RETRIES],
  );
}

/**
 * Erzeugt (einmalig) den Behebungsauftrag zu einem Bug; er läuft automatisch, auch ohne Sprint. Ohne `intro`
 * behebt er den Fehler, der den Auftrag `item` blockiert; Bugs aus dem Betrieb geben einen eigenen Einstieg mit.
 * Bugs aus fremden Quellen (Betrieb, GitHub) bekommen erst nach der Freigabe durch einen Menschen einen Auftrag;
 * ältere Beschreibungen ohne Fremdtext-Marker werden dabei als Fremdtext eingefasst.
 */
export async function queueBugFix(
  pool: Pool,
  item: Pick<FailedItem, 'title' | 'sprintId'>,
  bugId: string,
  intro?: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO development_items (project_slug, sprint_id, title, description, status, priority, kind, bug_id, auto_run)
     SELECT b.project_slug, $2, 'Bug: ' || b.title,
            COALESCE($4, 'Behebe den Fehler, der den Auftrag „' || $3 || '“ blockiert. Danach wird der Auftrag automatisch erneut gestartet.') || E'\n\n' ||
            CASE WHEN b.source IN ${UNTRUSTED_BUG_SOURCES_SQL} AND strpos(b.description, $5) = 0 AND strpos(b.description, $7) = 0
                 THEN $5 || E'\n' || b.description || E'\n' || $6 ELSE b.description END,
            'planned', 'high', 'bug', b.id, TRUE
       FROM bugs b WHERE b.id = $1 AND NOT ${unapprovedBugSql('b')}
     ON CONFLICT (bug_id) WHERE bug_id IS NOT NULL DO NOTHING`,
    [bugId, item.sprintId ?? null, item.title, intro ?? null, EXTERNAL_TEXT_START, EXTERNAL_TEXT_END, UNTRUSTED_START],
  );
}

/** Nach erfolgreicher Behebung: den blockierten Ursprungsauftrag erneut einplanen (begrenzte Versuche). */
export async function resumeBlockedByBug(pool: Pool, bugId: string): Promise<void> {
  await pool.query(
    `UPDATE development_items d SET status = 'planned', auto_run = TRUE, failure = NULL, action_todo = NULL, retry_count = retry_count + 1, updated_at = NOW()
      WHERE d.failure_bug_id = $1 AND d.status = 'blocked' AND d.kind <> 'bug' AND d.retry_count < $2
        AND (SELECT auto_bugfix FROM projects WHERE slug = d.project_slug)`,
    [bugId, MAX_AUTO_RETRIES],
  );
}

/**
 * Holt bei blockierten Aufträgen ohne Bug-Bericht (ältere Fehler) den Bericht und die Behebung nach. Läufe, die der
 * Benutzer abgebrochen hat („Abbrechen“, cancel_requested), sind kein Fehler und bekommen keinen Bericht.
 */
export async function backfillFailures(pool: Pool, project: string): Promise<void> {
  const blocked = await pool.query<FailedItem & { agentName: string | null; output: string | null }>(
    `SELECT d.id, d.project_slug AS "projectSlug", d.title, d.kind, d.bug_id AS "bugId", d.sprint_id AS "sprintId",
            last.agent_name AS "agentName", last.output
       FROM development_items d
       LEFT JOIN LATERAL (
         SELECT st.agent_name, st.output, st.run_id FROM agent_run_steps st JOIN agent_runs r ON r.id = st.run_id
          WHERE r.development_id = d.id AND st.status = 'failed' ORDER BY r.started_at DESC, st.position DESC LIMIT 1
       ) last ON TRUE
      WHERE d.project_slug = $1 AND d.status = 'blocked' AND d.failure IS NULL AND d.kind <> 'bug' AND last.agent_name IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM agent_run_steps c WHERE c.run_id = last.run_id AND c.cancel_requested)`,
    [project],
  );
  for (const item of blocked.rows) {
    await registerFailure(pool, item, item.agentName ?? 'Agent', item.output ?? '');
  }
}
