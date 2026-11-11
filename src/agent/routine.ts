import type { Pool, PoolClient } from 'pg';
import { logged } from '../core/log.js';
import { inWindow, nextRoutineRun } from '../core/cron.js';
import { sendPush } from '../core/push.js';
import { markerCategory, markerPriority, markerScore, markerTitle, parseMarkerLines } from './visionary.js';
import { defined } from '../core/defined.js';
import { AGENT_RUN_STATUS, BUG_STATUS, DEVELOPMENT_STATUS, IDEATION_STATUS } from '../core/status.js';

/**
 * Zeitgesteuerte Routinen: Der Planer im Worker reiht fällige Agent-Aufgaben als Chat-Nachricht mit Herkunft
 * „Routine“ ein; der Assistent führt sie aus. Danach wertet dieses Modul die Antwort aus (Marker → Bug, Idee,
 * Auftrag im Backlog), schreibt das Lauf-Protokoll und zählt Fehlschläge (nach drei in Folge: pausiert).
 */
export const ROUTINE_ORIGIN = 'routine';
/** Rolle der Routinen in den Rechten (tool-permissions: Shell unter dem Wächter, keine Datei-Werkzeuge). */
export const ROUTINE_ROLE = 'routine';
export const MAX_FAILURE_STREAK = 3;
export const OUTPUT_TARGETS = ['chat', 'push', 'bug', 'idea', 'order'] as const;
export type OutputTarget = (typeof OUTPUT_TARGETS)[number];
/** Höchstens so viele Einträge je Marker-Art und Lauf (Schutz vor Endlos-Listen). */
const MAX_ITEMS_PER_KIND = 10;

export const TARGET_LABELS: Record<OutputTarget, string> = {
  chat: 'Chat',
  push: 'Push',
  bug: 'Bug',
  idea: 'Idee',
  order: 'Auftrag im Backlog',
};

/**
 * Fehler der Umgebung statt der Routine: Agent-Befehl fehlt (spawn ENOENT), Projektordner nicht erreichbar, Budget
 * erreicht. Sie werden gemeldet, zählen aber nicht zu den Fehlschlägen in Folge.
 */
const ENVIRONMENT_PATTERNS = [
  /im PATH des Workers nicht gefunden/,
  /\bspawn \S+ ENOENT\b/,
  /\bENOENT\b/,
  /Arbeitsordner nicht erreichbar/,
  /Projektordner nicht gefunden/,
  /Der Assistent kann nicht arbeiten/,
  /^Budget erreicht/m,
  /Unterbrochen: Der Worker wurde beendet/,
];

export function isEnvironmentFailure(output: string): boolean {
  return ENVIRONMENT_PATTERNS.some((pattern) => pattern.test(output));
}

/** Zusatz für den Prompt einer Routine: niemand wartet auf Rückfragen, nur lesen, Ergebnis über Marker. */
export function routineInstructions(target: OutputTarget): string {
  const wanted: Record<OutputTarget, string> = {
    chat: 'Das Ergebnis erscheint im Chat. Marker nur, wenn ein Befund eindeutig ein Bug, eine Idee oder ein Auftrag ist.',
    push: 'Das Ergebnis geht als Push-Meldung hinaus: fasse es im ersten Satz knapp zusammen.',
    bug: 'Melde jeden echten Befund als eigene `@@BUG`-Zeile.',
    idea: 'Melde jede Verbesserungsidee als eigene `@@IDEA`-Zeile.',
    order: 'Melde jede nötige Arbeit als eigene `@@ORDER`-Zeile (landet im Backlog).',
  };
  return [
    '## Zeitgesteuerte Routine',
    'Diese Anfrage kommt von einer zeitgesteuerten Routine; niemand wartet auf Rückfragen. Stelle keine Rückfrage (keine @@FRAGE-Zeile).',
    'Nur lesen: ändere keine Dateien, committe nichts, installiere nichts und starte oder stoppe keine Dienste. Das Ergebnis gibst du nur als Bericht und über die Marker-Zeilen weiter.',
    'Fehlt ein Messwert (z. B. weil ein Befehl blockiert ist), gilt das nicht als bestanden: nenne den fehlenden Wert als Hinweis.',
    `Ziel des Ergebnisses: ${TARGET_LABELS[target]}. ${wanted[target]}`,
    'Marker-Zeilen stehen am Ende der Antwort, je eine Zeile mit einem JSON-Objekt. Die Zeile beginnt direkt mit dem ' +
      'Marker – ohne Backticks und nicht in einem Codeblock; Marker mitten in der Zeile oder in Codeblöcken zählen nicht:',
    '@@BUG {"title": "...", "severity": "low|medium|high|critical", "description": "..."}',
    '@@IDEA {"title": "...", "category": "frontend|backend|fullstack|infrastructure|docs", "priority": "low|medium|high", "description": "..."}',
    '@@ORDER {"title": "...", "priority": "low|medium|high", "description": "..."}',
    'Ohne Befund keine Marker-Zeile.',
  ].join('\n');
}

/** Läuft für das Projekt gerade ein Auftrag (Projektsperre) oder ein kompletter Test im Projektordner? */
export const PROJECT_LOCKED_SQL = `(EXISTS (SELECT 1 FROM agent_runs r WHERE r.project_slug = t.project_slug AND r.status = '${AGENT_RUN_STATUS.running}')
   OR EXISTS (SELECT 1 FROM test_requests q WHERE q.project_slug = t.project_slug AND q.status = 'running'))`;

interface DueTask {
  id: string;
  projectSlug: string;
  title: string;
  prompt: string;
  agentId: string | null;
  schedule: string;
  runWindow: string | null;
  locked: boolean;
  open: boolean;
}

export interface ScheduleResult {
  queued: string[];
  /** Fällig, aber das Projekt ist gesperrt: läuft, sobald es frei ist. */
  waiting: string[];
  /** Übersprungen (außerhalb des Zeitfensters oder voriger Lauf noch offen); nächster Termin gesetzt. */
  skipped: string[];
}

/** Nachricht an den Assistenten: Titel als Überschrift, damit der Verlauf zeigt, welche Aufgabe lief. */
export function taskMessage(task: { title: string; prompt: string }, comment = ''): string {
  const note = comment.trim().slice(0, 2000);
  return `Aufgabe „${task.title}“:\n${task.prompt}${note ? `\n\nHinweis dazu: ${note}` : ''}`;
}

/**
 * Planer (einmal pro Minute): fällige Routinen der Projekte dieses Workers sperren (FOR UPDATE SKIP LOCKED – zwei
 * Worker reihen eine Routine nie doppelt ein), als Chat-Nachricht mit Herkunft „Routine“ einreihen und
 * next_run_at neu berechnen. Gesperrte Projekte bleiben fällig und laufen, sobald die Sperre frei ist.
 */
export async function scheduleRoutines(
  pool: Pool,
  projects: readonly string[],
  now = new Date(),
): Promise<ScheduleResult> {
  const result: ScheduleResult = { queued: [], waiting: [], skipped: [] };
  if (!projects.length) return result;
  // Läufe, deren Chat-Nachricht gelöscht wurde („Chat leeren“), kommen nie an: abbrechen, damit die Routine weiterläuft.
  await pool
    .query(
      `UPDATE agent_task_runs SET status = 'cancelled', finished_at = NOW(),
              error = 'Chat-Nachricht gelöscht – Lauf abgebrochen.'
        WHERE status = 'queued' AND message_id IS NULL AND queued_at < NOW() - INTERVAL '1 minute'`,
    )
    .catch(logged('routine'));
  // Aktive Routinen ohne Termin (z. B. direkt in der Datenbank angelegt): nächsten Lauf nachtragen.
  const missing = await pool.query<{ id: string; schedule: string; runWindow: string | null }>(
    `SELECT id, schedule, run_window AS "runWindow" FROM agent_tasks
      WHERE enabled AND schedule IS NOT NULL AND next_run_at IS NULL AND project_slug = ANY($1::text[])`,
    [projects],
  );
  for (const task of missing.rows) {
    await pool.query(`UPDATE agent_tasks SET next_run_at = $2 WHERE id = $1 AND next_run_at IS NULL`, [
      task.id,
      nextRoutineRun(task.schedule, task.runWindow, now),
    ]);
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const due = (
      await client.query<DueTask>(
        `SELECT t.id, t.project_slug AS "projectSlug", t.title, t.prompt, t.agent_id AS "agentId", t.schedule,
                t.run_window AS "runWindow", ${PROJECT_LOCKED_SQL} AS locked,
                EXISTS (SELECT 1 FROM agent_task_runs x WHERE x.task_id = t.id AND x.status IN ('queued', 'running')) AS open
           FROM agent_tasks t
          WHERE t.enabled AND t.schedule IS NOT NULL AND t.next_run_at <= $1 AND t.project_slug = ANY($2::text[])
          ORDER BY t.next_run_at
          LIMIT 20
          FOR UPDATE OF t SKIP LOCKED`,
        [now, projects],
      )
    ).rows;
    for (const task of due) {
      if (task.locked) {
        result.waiting.push(task.id);
        continue;
      }
      const next = nextRoutineRun(task.schedule, task.runWindow, now);
      if (task.open || !inWindow(now, task.runWindow)) {
        // Voriger Lauf noch nicht fertig oder Fenster vorbei (z. B. wegen langer Projektsperre): diesen Termin auslassen.
        await client.query(`UPDATE agent_tasks SET next_run_at = $2 WHERE id = $1`, [task.id, next]);
        result.skipped.push(task.id);
        continue;
      }
      await queueRun(client, task, 'schedule', taskMessage(task));
      await client.query(`UPDATE agent_tasks SET next_run_at = $2 WHERE id = $1`, [task.id, next]);
      result.queued.push(task.id);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  return result;
}

/** Legt Lauf und Chat-Nachricht an (in der Transaktion des Aufrufers); liefert die Nachricht. */
export async function queueRun(
  client: Pool | PoolClient,
  task: { id: string; projectSlug: string; agentId: string | null },
  trigger: 'schedule' | 'manual',
  content: string,
): Promise<{ runId: string; message: Record<string, unknown> }> {
  const runId = defined(
    (
      await client.query<{ id: string }>(
        `INSERT INTO agent_task_runs (task_id, project_slug, trigger) VALUES ($1, $2, $3) RETURNING id`,
        [task.id, task.projectSlug, trigger],
      )
    ).rows[0],
  ).id;
  const message = defined(
    (
      await client.query<{ id: string }>(
        `INSERT INTO chat_messages (project_slug, role, content, status, agent_id, agent_name, origin, task_run_id)
       VALUES ($1, 'user', $2, 'pending', $3, (SELECT name FROM agents WHERE id = $3), $4, $5)
       RETURNING id, role, content, status, origin, created_at AS "createdAt"`,
        [task.projectSlug, content, task.agentId, trigger === 'schedule' ? ROUTINE_ORIGIN : 'user', runId],
      )
    ).rows[0],
  );
  await client.query(`UPDATE agent_task_runs SET message_id = $2 WHERE id = $1`, [runId, message.id]);
  await client.query(
    `UPDATE agent_tasks SET run_count = run_count + 1, last_run_at = NOW(), last_status = 'queued' WHERE id = $1`,
    [task.id],
  );
  return { runId, message };
}

export interface RoutineRun {
  id: string;
  taskId: string;
  trigger: 'schedule' | 'manual';
  status: string;
  title: string;
  outputTarget: OutputTarget;
}

/** Lauf zur übernommenen Chat-Nachricht starten; null, wenn die Nachricht zu keinem Lauf gehört. */
export async function startTaskRun(pool: Pool, runId: string | null): Promise<RoutineRun | null> {
  if (!runId) return null;
  const run = (
    await pool.query<RoutineRun>(
      `UPDATE agent_task_runs r SET status = 'running', started_at = NOW()
         FROM agent_tasks t
        WHERE r.id = $1 AND t.id = r.task_id AND r.status IN ('queued', 'running')
        RETURNING r.id, r.task_id AS "taskId", r.trigger, r.status, t.title, t.output_target AS "outputTarget"`,
      [runId],
    )
  ).rows[0];
  if (run) await pool.query(`UPDATE agent_tasks SET last_status = 'running' WHERE id = $1`, [run.taskId]);
  return run ?? null;
}

/** Worker beendet oder Ordner kurz weg: Lauf wartet wieder (die Chat-Nachricht ist wieder „pending“). */
export async function requeueTaskRun(pool: Pool, runId: string): Promise<void> {
  await pool.query(
    `UPDATE agent_task_runs SET status = 'queued', started_at = NULL WHERE id = $1 AND status = 'running'`,
    [runId],
  );
}

export interface CreatedItem {
  kind: 'bug' | 'idea' | 'order';
  id: string;
  title: string;
}

const SEVERITY_ALIASES: Record<string, string> = {
  low: 'low',
  niedrig: 'low',
  gering: 'low',
  medium: 'medium',
  mittel: 'medium',
  high: 'high',
  hoch: 'high',
  critical: 'critical',
  kritisch: 'critical',
};

const description = (record: Record<string, unknown>): string =>
  typeof record.description === 'string' ? record.description.trim().slice(0, 8000) : '';

/** Herkunftsangabe unter jedem angelegten Eintrag (Routine, Lauf, Chat-Nachricht). */
export function originNote(task: string, runId: string, messageId: string | null, at = new Date()): string {
  const when = at.toLocaleString('de-CH', { timeZone: 'Europe/Zurich', dateStyle: 'short', timeStyle: 'short' });
  return `---\n_Quelle: Routine „${task}“ · Lauf vom ${when} · Lauf ${runId}${messageId ? ` · Chat-Nachricht ${messageId}` : ''}_`;
}

/**
 * Legt aus den Marker-Zeilen Bugs, Ideen und Aufträge im Backlog an (Quelle „Routine“, Verweis auf den Lauf). Offene
 * Einträge mit gleichem Titel werden nicht doppelt angelegt; ungültige Zeilen kommen als Hinweis ins Protokoll.
 */
export async function storeMarkers(
  pool: Pool,
  project: string,
  run: { id: string; title: string; messageId: string | null },
  output: string,
): Promise<{ created: CreatedItem[]; notes: string[] }> {
  const parsed = parseMarkerLines(output);
  const notes = parsed.discarded.map((entry) => `${entry.problem} ${entry.line.slice(0, 200)}`);
  const created: CreatedItem[] = [];
  const counts = new Map<string, number>();
  const footer = originNote(run.title, run.id, run.messageId);
  for (const { marker, line, record } of parsed.lines) {
    const title = markerTitle(record);
    if (title.length < 3) {
      notes.push(`Titel fehlt. ${line.slice(0, 200)}`);
      continue;
    }
    const count = (counts.get(marker) ?? 0) + 1;
    counts.set(marker, count);
    if (count > MAX_ITEMS_PER_KIND) {
      notes.push(`Mehr als ${MAX_ITEMS_PER_KIND} ${marker}-Zeilen – „${title}“ nicht angelegt.`);
      continue;
    }
    const body = [description(record), footer].filter(Boolean).join('\n\n');
    let id: string | undefined;
    let kind: CreatedItem['kind'];
    if (marker === '@@BUG') {
      kind = 'bug';
      const severity =
        SEVERITY_ALIASES[
          String(record.severity ?? '')
            .toLowerCase()
            .trim()
        ] ?? 'medium';
      id = (
        await pool.query<{ id: string }>(
          `INSERT INTO bugs (project_slug, title, description, severity, source, category, routine_run_id)
           SELECT $1, $2, $3, $4, 'routine', $5, $6
            WHERE NOT EXISTS (SELECT 1 FROM bugs WHERE project_slug = $1 AND lower(title) = lower($2)
                                AND status IN ('${BUG_STATUS.open}', '${BUG_STATUS.inProgress}'))
           RETURNING id`,
          [project, title, body, severity, markerCategory(record.category), run.id],
        )
      ).rows[0]?.id;
    } else if (marker === '@@IDEA') {
      kind = 'idea';
      id = (
        await pool.query<{ id: string }>(
          `INSERT INTO ideation_items (project_slug, title, description, priority, category, benefit, cost, source,
                                       routine_run_id)
           SELECT $1, $2, $3, $4, $5, $6, $7, 'routine', $8
            WHERE NOT EXISTS (SELECT 1 FROM ideation_items WHERE project_slug = $1 AND lower(title) = lower($2)
                                AND status NOT IN ('${IDEATION_STATUS.accepted}', '${IDEATION_STATUS.rejected}'))
           RETURNING id`,
          [
            project,
            title,
            body,
            markerPriority(record.priority),
            markerCategory(record.category),
            markerScore(record.benefit),
            markerScore(record.cost),
            run.id,
          ],
        )
      ).rows[0]?.id;
    } else {
      kind = 'order';
      id = (
        await pool.query<{ id: string }>(
          `INSERT INTO development_items (project_slug, title, description, status, priority, kind, category,
                                          auto_run, routine_run_id)
           SELECT $1, $2, $3, '${DEVELOPMENT_STATUS.backlog}', $4, 'feature', $5, FALSE, $6
            WHERE NOT EXISTS (SELECT 1 FROM development_items WHERE project_slug = $1 AND lower(title) = lower($2)
                                AND status NOT IN ('${DEVELOPMENT_STATUS.done}', '${DEVELOPMENT_STATUS.rejected}'))
           RETURNING id`,
          [project, title, body, markerPriority(record.priority), markerCategory(record.category), run.id],
        )
      ).rows[0]?.id;
    }
    if (id) created.push({ kind, id, title });
    else notes.push(`${TARGET_LABELS[kind]} „${title}“ ist bereits offen – nicht doppelt angelegt.`);
  }
  return { created, notes };
}

/** Marker-Zeilen aus dem Chat-Text entfernen; die angelegten Einträge stehen als Liste darunter. */
export function stripMarkers(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !/^\s*@@(?:BUG|IDEA|ORDER)(?![A-Z_])/.test(line))
    .join('\n')
    .trim();
}

export function createdSummary(created: readonly CreatedItem[], notes: readonly string[]): string {
  const lines = created.map((item) => `- ${TARGET_LABELS[item.kind]} angelegt: „${item.title}“`);
  if (notes.length) lines.push(...notes.map((note) => `- Hinweis: ${note}`));
  return lines.length ? `**Weitergeleitet:**\n${lines.join('\n')}` : '';
}

/** Kurzer Fehlertext aus der Ausgabe (letzte aussagekräftige Zeilen). */
export function failureReason(output: string): string {
  const text = output.trim();
  if (!text) return 'Der Assistent hat keine Antwort geliefert.';
  return text.length > 400 ? `…${text.slice(-400)}` : text;
}

export interface FinishInput {
  run: RoutineRun;
  project: string;
  messageId: string | null;
  answerId?: string | null;
  failed: boolean;
  output: string;
  tokens: number;
  durationMs: number;
  /** Umgebungsfehler erzwingen (z. B. Projekt nicht arbeitsfähig). */
  environment?: boolean;
}

/**
 * Lauf abschließen: Marker auswerten (nur bei Routinen), Protokoll schreiben, Fehlschläge zählen und pausieren,
 * genau eine Push-Meldung je Fehlschlag. Liefert den Zusatz für die Chat-Antwort.
 */
export async function finishTaskRun(
  pool: Pool,
  input: FinishInput,
  push: typeof sendPush = sendPush,
): Promise<{ summary: string; paused: boolean }> {
  const { run } = input;
  const scheduled = run.trigger === 'schedule';
  const task = (
    await pool.query<{ streak: number; enabled: boolean; status: string }>(
      `SELECT t.failure_streak AS streak, t.enabled, r.status
         FROM agent_task_runs r JOIN agent_tasks t ON t.id = r.task_id WHERE r.id = $1`,
      [run.id],
    )
  ).rows[0];
  if (!task) return { summary: '', paused: false };
  // Inzwischen abgebrochen (Pausieren durch den Nutzer): kein Fehlschlag, keine Meldung.
  if (task.status === 'cancelled') return { summary: '', paused: false };
  const link = `#dashboard?project=${encodeURIComponent(input.project)}`;
  if (input.failed) {
    const environment = input.environment || isEnvironmentFailure(input.output);
    const reason = failureReason(input.output);
    const streak = scheduled && !environment ? task.streak + 1 : task.streak;
    const paused = scheduled && task.enabled && streak >= MAX_FAILURE_STREAK;
    const error = environment
      ? `Umgebungsfehler (zählt nicht als Fehlschlag): ${reason}`
      : paused
        ? `Pausiert nach ${MAX_FAILURE_STREAK} Fehlschlägen in Folge. Letzter Fehler: ${reason}`
        : reason;
    await pool.query(
      `UPDATE agent_task_runs SET status = 'failed', finished_at = NOW(), duration_ms = $2, tokens = $3, error = $4,
              environment_error = $5, answer_id = COALESCE($6, answer_id)
        WHERE id = $1`,
      [run.id, Math.round(input.durationMs), input.tokens, reason, environment, input.answerId ?? null],
    );
    await pool.query(
      `UPDATE agent_tasks SET last_status = 'failed', last_error = $2, failure_streak = $3,
              enabled = CASE WHEN $4 THEN FALSE ELSE enabled END
        WHERE id = $1`,
      [run.taskId, error, streak, paused],
    );
    await push(
      pool,
      {
        title: paused
          ? `⏸ Routine „${run.title}“ pausiert · ${input.project}`
          : environment
            ? `⚠ Routine „${run.title}“: Umgebungsfehler · ${input.project}`
            : `⚠ Routine „${run.title}“ fehlgeschlagen · ${input.project}`,
        body: error.replace(/\s+/g, ' ').slice(0, 180),
        url: link,
        tag: `routine-${run.taskId}`,
      },
      { project: input.project },
    ).catch(logged('routine'));
    return { summary: '', paused };
  }
  const { created, notes }: { created: CreatedItem[]; notes: string[] } = scheduled
    ? await storeMarkers(
        pool,
        input.project,
        { id: run.id, title: run.title, messageId: input.messageId },
        input.output,
      )
    : { created: [], notes: [] };
  await pool.query(
    `UPDATE agent_task_runs SET status = 'ok', finished_at = NOW(), duration_ms = $2, tokens = $3, notes = $4::jsonb,
            created_items = $5::jsonb, answer_id = COALESCE($6, answer_id), error = NULL
      WHERE id = $1`,
    [
      run.id,
      Math.round(input.durationMs),
      input.tokens,
      JSON.stringify(notes),
      JSON.stringify(created),
      input.answerId ?? null,
    ],
  );
  await pool.query(
    `UPDATE agent_tasks SET last_status = 'ok', last_error = CASE WHEN enabled THEN NULL ELSE last_error END,
            failure_streak = CASE WHEN $2 THEN 0 ELSE failure_streak END
      WHERE id = $1`,
    [run.taskId, scheduled],
  );
  if (scheduled && run.outputTarget === 'push') {
    await push(
      pool,
      {
        title: `✅ Routine „${run.title}“ · ${input.project}`,
        body: stripMarkers(input.output).replace(/\s+/g, ' ').slice(0, 180) || 'Erledigt.',
        url: link,
        tag: `routine-${run.taskId}`,
      },
      { project: input.project },
    ).catch(logged('routine'));
  }
  return { summary: createdSummary(created, notes), paused: false };
}

/** Antwort-Nachricht nachträglich mit dem Lauf verknüpfen. */
export async function linkAnswer(pool: Pool, runId: string, answerId: string): Promise<void> {
  await pool.query(`UPDATE agent_task_runs SET answer_id = $2 WHERE id = $1`, [runId, answerId]);
}
