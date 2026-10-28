import { logged } from '../core/log.js';
import type { Pool } from 'pg';
import { type CommandExecutor, runCommand } from '../core/command.js';
import { folderAvailable, hadOutage } from '../core/folder-guard.js';
import { tryAcquireTree } from '../core/project-lock.js';
import { isShuttingDown } from '../core/shutdown.js';
import { sendPush } from '../core/push.js';
import { startProgress } from './chat-progress.js';
import { runAuthorAgent } from './requirements.js';
import { closeExpressOrder, openExpressOrder } from './express-order.js';
import { saveRequestDoc } from './request-doc.js';
import { type ChatReference, referenceContext } from './chat-references.js';
import { replyToIdeaComment } from '../api/idea-comments.js';
import type { RunnerOptions } from '../runner/runner.js';
import {
  finishTaskRun,
  linkAnswer,
  requeueTaskRun,
  ROUTINE_ORIGIN,
  ROUTINE_ROLE,
  routineInstructions,
  startTaskRun,
  stripMarkers,
} from './routine.js';

const HISTORY_LIMIT = 20;
const QUESTION_MARKER = /^@@FRAGE:\s*(.+)$/m;
const OPTIONS_MARKER = /^@@OPTIONEN:\s*(.+)$/m;
const MAX_OPTIONS = 4;
const QUESTION_RULE =
  'Rückfragen: Fehlt dir eine Information, ohne die du nicht sinnvoll weiterarbeiten kannst (z. B. eine Entscheidung zwischen klaren Alternativen), arbeite so weit wie möglich und stelle dann genau eine kurze Rückfrage. Beende die Antwort in diesem Fall mit einer eigenen Zeile `@@FRAGE: <deine Frage>`. Gibt es naheliegende Antworten, nenne sie in einer weiteren Zeile `@@OPTIONEN: <Antwort 1> | <Antwort 2>` (höchstens 4, je ein kurzer Satz, den der Nutzer anklicken kann). Frage nicht, wenn du sinnvoll selbst entscheiden kannst.';

/** Trennt die Rückfrage (@@FRAGE-Zeile) vom übrigen Antworttext. */
export function splitQuestion(output: string): { text: string; question: string | null; options: string[] } {
  const question = QUESTION_MARKER.exec(output)?.[1]?.trim() || null;
  const options = question
    ? [
        ...new Set(
          (OPTIONS_MARKER.exec(output)?.[1] ?? '')
            .split('|')
            .map((option) => option.trim().slice(0, 200))
            .filter(Boolean),
        ),
      ].slice(0, MAX_OPTIONS)
    : [];
  const text = output
    .replace(/^@@TASK\b.*$/gm, '')
    .replace(QUESTION_MARKER, '')
    .replace(OPTIONS_MARKER, '')
    .trim();
  return { text: text || question || 'Erledigt.', question, options };
}
export interface ChatAgent {
  name: string;
  role: string;
  instructions: string;
}

/** Vom Nutzer gewählter Agent: Bezeichnung und Beschreibung bestimmen, wie die Anfrage bearbeitet wird. */
export function agentIdentity(agent: ChatAgent | null): string {
  if (!agent)
    return 'Du bist der allgemeine Assistent dieses Projekts im AIdeation. Beantworte Fragen knapp und auf Deutsch.';
  return [
    `Du übernimmst diese Anfrage als Agent „${agent.name}“ dieses Projekts im AIdeation. Antworte knapp und auf Deutsch.`,
    agent.instructions.trim() ? `## Deine Rolle und Arbeitsweise\n${agent.instructions.trim()}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function buildChatPrompt(
  history: { role: string; content: string }[],
  agent: ChatAgent | null = null,
  references = '',
  /** Zusatz einer zeitgesteuerten Routine (ersetzt die Regel für Rückfragen). */
  routine = '',
): string {
  return [
    agentIdentity(agent),
    references,
    'Du bist der Einstiegspunkt für alle Anfragen. Sage NIE „das darf ich nicht“, „dafür habe ich kein Tool“ oder „mach das selbst“.',
    'Du bist zugleich der Problemlöser und hast erweiterte Rechte innerhalb des Projektordners: untersuche und behebe gemeldete Fehler selbst, führe passende Tests aus und verwalte Dienste mit docker compose (ps, logs, up -d, stop, start, restart, down, build) und setze Umgebungen auf (git clone, npm install --ignore-scripts). Stoppen mit "docker compose stop" oder "docker compose down" ist erlaubt. Führe Befehle mit deinem Shell-Werkzeug aus (run_command bzw. Bash) und melde ihr tatsächliches Ergebnis. Wird ein Befehl abgelehnt, nenne ihn wörtlich, statt zu behaupten, er sei gelaufen. Diagnostiziere selbst, statt den Nutzer um Ausgaben zu bitten: Dienst-Logs liegen unter ~/Library/Logs (z. B. mainty-dev-live.log, lies sie mit deinem Lese-Werkzeug), lokale Webseiten und APIs prüfst du mit WebFetch (nur localhost), laufende Prozesse und Ports mit ps und lsof -i, Container mit docker ps und docker compose logs. Hängt der Live-Modus eines Projekts, starte ihn mit `launchctl kickstart -k gui/<uid>/ch.<projekt>.dev-live` neu (uid mit `id -u`), statt Prozesse mit kill zu beenden. Änderungen und Befehle müssen im Projektkontext bleiben.',
    'Führe die Anfrage direkt selbst aus. Erstelle niemals Aufträge, schreibe niemals @@TASK-Zeilen und delegiere nicht an andere Agents. Wenn du etwas machst, nutze deine Werkzeuge und berichte anschließend konkret über die ausgeführten Schritte und das Ergebnis.',
    routine || QUESTION_RULE,
    `## Gespräch\n${history.map((message) => `${message.role === 'user' ? 'Nutzer' : 'Assistent'}: ${message.content}`).join('\n\n')}`,
    'Arbeite jetzt selbst an der letzten Nutzernachricht. Gib keine vorgeschlagenen Auftragszeilen aus.',
  ]
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Gesprächsverlauf bis einschließlich der übernommenen Nachricht. Später eingegangene und noch wartende bzw. gerade
 * bearbeitete Nutzernachrichten bleiben draussen – sonst beantwortet der Lauf für Nachricht 1 schon Nachricht 2.
 * Fertige Antworten zählen unabhängig vom Zeitpunkt: Die Antwort auf Nachricht 1 entsteht oft erst, nachdem Nachricht 2
 * schon wartete. Die übernommene Nachricht steht deshalb immer am Ende.
 */
export async function loadChatHistory(
  pool: Pick<Pool, 'query'>,
  project: string,
  claimedId: string,
): Promise<{ rows: { role: string; content: string }[] }> {
  const { rows } = await pool.query<{ id: string; role: string; content: string }>(
    `SELECT id, role, content FROM (SELECT id, role, content, created_at FROM chat_messages
      WHERE project_slug = $1 AND status <> 'failed' AND NOT (role = 'assistant' AND status = 'processing')
        AND (role <> 'user' OR created_at <= (SELECT created_at FROM chat_messages WHERE id = $3))
        AND (role <> 'user' OR status NOT IN ('pending', 'processing') OR id = $3)
      ORDER BY id = $3 DESC, created_at DESC LIMIT $2) recent ORDER BY created_at`,
    [project, HISTORY_LIMIT, claimedId],
  );
  const claimed = rows.filter((row) => row.id === claimedId);
  return {
    rows: [...rows.filter((row) => row.id !== claimedId), ...claimed].map(({ role, content }) => ({ role, content })),
  };
}

/**
 * Antwort auf eine Rückfrage: dieselbe Claude-Sitzung fortsetzen, damit der Agent den Kontext behält. Verweist die
 * Antwort ausdrücklich auf eine Rückfrage, gilt diese – auch wenn inzwischen anderes im Chat stand. Sonst zählt nur
 * eine Rückfrage, die vor der übernommenen Nachricht entstand: Eine schon wartende Nachricht ist keine Antwort auf
 * eine Rückfrage, die erst danach gestellt wurde.
 */
export async function findOpenQuestion(
  pool: Pick<Pool, 'query'>,
  project: string,
  claimed: { id: string; agentId: string | null; replyTo: string | null },
): Promise<{ id: string; question: string; sessionId: string | null } | undefined> {
  const result = claimed.replyTo
    ? await pool.query<{ id: string; question: string; sessionId: string | null }>(
        `SELECT id, question, session_id AS "sessionId" FROM chat_messages
        WHERE id = $1 AND project_slug = $2 AND question IS NOT NULL`,
        [claimed.replyTo, project],
      )
    : await pool.query<{ id: string; question: string; sessionId: string | null }>(
        `SELECT id, question, session_id AS "sessionId" FROM chat_messages
        WHERE project_slug = $1 AND role = 'assistant' AND status = 'done' AND question IS NOT NULL
          AND agent_id IS NOT DISTINCT FROM $3
          AND created_at < (SELECT created_at FROM chat_messages WHERE id = $2)
          AND created_at > COALESCE((SELECT max(created_at) FROM chat_messages
                                      WHERE project_slug = $1 AND role = 'user' AND id <> $2), '-infinity')
        ORDER BY created_at DESC LIMIT 1`,
        [project, claimed.id, claimed.agentId],
      );
  return result.rows[0];
}

/**
 * Arbeitet gerade ein Auftrag (oder ein Testlauf, auch in einem anderen Worker) im selben Ordner, antwortet der
 * Assistent nur lesend: seine Änderungen landeten sonst im Commit des Auftrags, und ein `git checkout` wechselte dem
 * Auftrag den Branch. Sonst hält er den Ordner, bis er fertig ist. Prüfen und Nehmen in einem Schritt.
 */
export async function claimChatTree(cwd: string): Promise<{ readOnly: boolean; releaseTree?: () => void }> {
  const releaseTree = await tryAcquireTree(cwd);
  return releaseTree ? { readOnly: false, releaseTree } : { readOnly: true };
}

/** Answers the oldest pending chat message of a project; returns false when nothing was waiting. */
const READ_ONLY_NOTE =
  'Hinweis: Gerade arbeitet ein Auftrag im Projektordner. Du kannst nur lesen und antworten, aber keine Dateien ' +
  'ändern und keine Befehle ausführen. Was geändert werden soll, beschreibe als Vorschlag.';

/** Prompt für die fortgesetzte Sitzung: Antwort auf die Rückfrage samt Verweisen und, falls belegt, Nur-lesen-Hinweis. */
export function resumePrompt(question: string, answer: string, references: string, readOnly: boolean): string {
  return [
    `Antwort des Nutzers auf deine Rückfrage „${question}“:\n${answer}`,
    references,
    `Arbeite damit weiter. ${QUESTION_RULE}`,
    readOnly ? READ_ONLY_NOTE : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

export async function processChat(
  pool: Pool,
  options: Pick<RunnerOptions, 'project' | 'cwd' | 'timeoutMs'>,
  execute: CommandExecutor = runCommand,
): Promise<boolean> {
  const claimed = (
    await pool.query<{
      id: string;
      content: string;
      agentId: string | null;
      references: ChatReference[];
      ideaCommentId: string | null;
      replyTo: string | null;
      origin: string;
      taskRunId: string | null;
    }>(
      `UPDATE chat_messages SET status = 'processing', updated_at = clock_timestamp()
      WHERE id = (SELECT id FROM chat_messages WHERE project_slug = $1 AND role = 'user' AND status = 'pending'
                   ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING id, content, agent_id AS "agentId", refs AS "references", idea_comment_id AS "ideaCommentId",
                reply_to AS "replyTo", origin, task_run_id AS "taskRunId"`,
      [options.project],
    )
  ).rows[0];
  if (!claimed) return false;
  // Lauf einer Agent-Aufgabe (Routine oder Klick): Protokoll starten. Routinen arbeiten ohne Chat-Verlauf und Rückfragen.
  const run = await startTaskRun(pool, claimed.taskRunId).catch(logged('chat', null));
  const routine = claimed.origin === ROUTINE_ORIGIN;
  const agent = claimed.agentId
    ? ((await pool.query<ChatAgent>('SELECT name, role, instructions FROM agents WHERE id = $1', [claimed.agentId]))
        .rows[0] ?? null)
    : null;
  const history = routine
    ? { rows: [{ role: 'user', content: claimed.content }] }
    : await loadChatHistory(pool, options.project, claimed.id);
  const openQuestion = routine ? undefined : await findOpenQuestion(pool, options.project, claimed);
  // Anfragen aus dem Dashboard (nicht @Agent in Ideen-Kommentaren) erscheinen als Express-Auftrag im Sprint.
  const expressId =
    claimed.ideaCommentId || routine
      ? null
      : await openExpressOrder(pool, options.project, claimed, openQuestion?.id ?? null).catch((error: unknown) => {
          console.error('Express-Auftrag konnte nicht angelegt werden:', error);
          return null;
        });
  const references = await referenceContext(pool, options.project, claimed.references ?? []).catch(() => '');
  const progress = await startProgress(pool, options.project, [
    'Lese die Anfrage und den Projektkontext …',
    'Analysiere die Anfrage …',
    'Prüfe die Ergebnisse …',
    'Fasse die Ergebnisse zusammen …',
  ]);
  const startedAt = Date.now();
  const folderAtStart = folderAvailable(options.cwd);
  // Ordner belegt (Auftrag, Testlauf, anderer Worker) → nur lesend; sonst hält der Chat ihn bis zum Ende der Antwort.
  const { readOnly, releaseTree } = await claimChatTree(options.cwd);
  const resume = openQuestion?.sessionId
    ? {
        sessionId: openQuestion.sessionId,
        prompt: resumePrompt(openQuestion.question, claimed.content, references, readOnly),
      }
    : undefined;
  const { exitCode, output, sessionId, tokens } = await runAuthorAgent(
    pool,
    options,
    () =>
      `${buildChatPrompt(history.rows, agent, references, routine ? routineInstructions(run?.outputTarget ?? 'chat') : '')}${
        readOnly ? `\n\n${READ_ONLY_NOTE}` : ''
      }`,
    execute,
    // Routinen: Rolle „routine“ – Shell unter dem Wächter, aber keine Datei-Werkzeuge (nur lesen).
    routine ? ROUTINE_ROLE : 'assistant',
    progress.update,
    resume,
    claimed.agentId,
    undefined,
    readOnly,
  ).finally(() => {
    progress.stop();
    releaseTree?.();
  });
  // Worker beendet oder Projektordner zwischendurch weg (Laufwerk getrennt): Anfrage bleibt wartend und läuft erneut,
  // statt mit einer irreführenden Fehlermeldung zu scheitern.
  if (isShuttingDown() || (exitCode !== 0 && folderAtStart && hadOutage(options.cwd, startedAt))) {
    await pool.query(`UPDATE chat_messages SET status = 'pending', updated_at = clock_timestamp() WHERE id = $1`, [
      claimed.id,
    ]);
    if (run) await requeueTaskRun(pool, run.id).catch(logged('chat'));
    return true;
  }
  /** Lauf einer Agent-Aufgabe abschließen: Protokoll, Marker (Routine), Fehlerzählung und Push. */
  const finish = (failed: boolean): Promise<{ summary: string; paused: boolean }> =>
    run
      ? finishTaskRun(pool, {
          run,
          project: options.project,
          messageId: claimed.id,
          failed,
          output,
          tokens: tokens ?? 0,
          durationMs: Date.now() - startedAt,
        }).catch(logged('chat', { summary: '', paused: false }))
      : Promise.resolve({ summary: '', paused: false });
  if (exitCode !== 0 || !output) {
    await pool.query(`UPDATE chat_messages SET status = 'failed', updated_at = clock_timestamp() WHERE id = $1`, [
      claimed.id,
    ]);
    const failedAnswer = await pool.query<{ id: string }>(
      `INSERT INTO chat_messages (project_slug, role, content, events, agent_id, agent_name, development_id, origin)
       VALUES ($1, 'assistant', $2, $3::jsonb, $4, $5, $6, $7) RETURNING id`,
      [
        options.project,
        `Die Anfrage konnte nicht bearbeitet werden.${output ? `\n${output.slice(0, 500)}` : ''}`,
        JSON.stringify(progress.events()),
        claimed.agentId,
        agent?.name ?? null,
        expressId,
        claimed.origin,
      ],
    );
    // Fehlschlag einer Aufgabe: Protokoll, Zählung und genau eine Push-Meldung.
    await finish(true);
    const failedId = failedAnswer.rows[0]?.id;
    if (run && failedId) await linkAnswer(pool, run.id, failedId).catch(logged('chat'));
    if (expressId) await closeExpressOrder(pool, expressId).catch(logged('chat'));
    await saveRequestDoc(pool, options.project, {
      request: claimed.content,
      answer: output.slice(0, 2000),
      agentName: agent?.name ?? null,
      question: null,
      failed: true,
      at: new Date(),
    }).catch(logged('chat'));
    await replyToIdeaComment(
      pool,
      claimed.id,
      agent?.name ?? null,
      'Ich konnte die Anweisung nicht bearbeiten. Details stehen im Chat.',
    ).catch(logged('chat'));
    return true;
  }
  const split = splitQuestion(output);
  // Routine: Marker auswerten (Bug, Idee, Auftrag) und im Chat statt der Marker-Zeilen auflisten; keine Rückfrage.
  const finished = await finish(false);
  const text = routine
    ? [stripMarkers(split.text) || 'Erledigt.', finished.summary].filter(Boolean).join('\n\n')
    : split.text;
  const question = routine ? null : split.question;
  const answers = routine ? [] : split.options;
  // Auslöser war ein Kommentar mit @Agent: die Antwort erscheint auch als Kommentar bei der Idee.
  await replyToIdeaComment(pool, claimed.id, agent?.name ?? null, question ? `${text}\n\n❓ ${question}` : text).catch(
    (error: unknown) => console.error('Antwort an Ideen-Kommentar fehlgeschlagen:', error),
  );
  await pool.query(`UPDATE chat_messages SET status = 'done', updated_at = clock_timestamp() WHERE id = $1`, [
    claimed.id,
  ]);
  const answer = await pool.query<{ id: string }>(
    `INSERT INTO chat_messages (project_slug, role, content, events, question, session_id, agent_id, agent_name,
                                development_id, question_options, origin)
     VALUES ($1, 'assistant', $2, $3::jsonb, $4, $5, $6, $7, $8, $9::jsonb, $10) RETURNING id`,
    [
      options.project,
      text,
      JSON.stringify(progress.events()),
      question,
      sessionId ?? null,
      claimed.agentId,
      agent?.name ?? null,
      expressId,
      JSON.stringify(answers),
      claimed.origin,
    ],
  );
  const answerId = answer.rows[0]?.id;
  if (run && answerId) await linkAnswer(pool, run.id, answerId).catch(logged('chat'));
  if (expressId) {
    await closeExpressOrder(pool, expressId).catch((error: unknown) =>
      console.error('Express-Auftrag konnte nicht aktualisiert werden:', error),
    );
  }
  // Jede Anfrage samt Ergebnis landet unter Dokumentation → Anfragen.
  await saveRequestDoc(pool, options.project, {
    request: claimed.content,
    answer: text,
    agentName: agent?.name ?? null,
    question,
    failed: false,
    at: new Date(),
  }).catch((error) => console.error('Anfrage konnte nicht dokumentiert werden:', error));
  // Routinen melden sich selbst (Ziel „Push“ bzw. Fehlschlag), damit nachts nicht jeder Lauf das Handy weckt.
  if (routine) return true;
  await sendPush(
    pool,
    {
      title: question
        ? `❓ Rückfrage ${agent ? `von ${agent.name}` : 'des Assistenten'} · ${options.project}`
        : `💬 ${agent?.name ?? 'Assistent'} hat geantwortet · ${options.project}`,
      body: question ?? text.replace(/\s+/g, ' ').slice(0, 160),
      // Rückfrage zu einem Auftrag: Link öffnet den Auftrag mit dem Antwortfeld (auch vom Handy).
      url:
        question && expressId
          ? `#development/${expressId}?project=${encodeURIComponent(options.project)}&answer=1`
          : `#dashboard?project=${encodeURIComponent(options.project)}`,
      tag: `chat-${options.project}`,
    },
    { project: options.project },
  );
  return true;
}

/** Beantwortet wartende Chat-Nachrichten mit dem Grund, wenn das Projekt nicht arbeitsfähig ist. */
export async function rejectChat(pool: Pool, project: string, reason: string): Promise<void> {
  const pending = await pool.query<{ id: string; taskRunId: string | null }>(
    `UPDATE chat_messages SET status = 'failed', updated_at = clock_timestamp()
      WHERE project_slug = $1 AND role = 'user' AND status = 'pending' RETURNING id, task_run_id AS "taskRunId"`,
    [project],
  );
  if (!pending.rowCount) return;
  await pool.query(`INSERT INTO chat_messages (project_slug, role, content) VALUES ($1, 'assistant', $2)`, [
    project,
    `Der Assistent kann nicht arbeiten: ${reason}`,
  ]);
  // Wartende Läufe von Agent-Aufgaben: als Umgebungsfehler protokollieren und melden (zählt nicht als Fehlschlag).
  for (const message of pending.rows) {
    const run = await startTaskRun(pool, message.taskRunId).catch(logged('chat', null));
    if (!run) continue;
    await finishTaskRun(pool, {
      run,
      project,
      messageId: message.id,
      failed: true,
      environment: true,
      output: `Der Assistent kann nicht arbeiten: ${reason}`,
      tokens: 0,
      durationMs: 0,
    }).catch(logged('chat'));
  }
}
