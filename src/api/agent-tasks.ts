import type { Router, Response } from 'express';
import type { Pool } from 'pg';
import { access } from './access.js';
import { isRecord, isUuid, parseProjectSlug } from '../core/validation.js';
import { nextCronRun, nextRoutineRun, parseCron, parseWindow } from '../core/cron.js';
import { OUTPUT_TARGETS, type OutputTarget, queueRun, taskMessage } from '../agent/routine.js';
import { ROUTINE_TEMPLATES } from '../setup/templates.js';
import type { Principal } from './roles.js';

/**
 * Agent-Aufgaben: gespeicherte Anweisungen je Projekt, die mit einem Klick an den Assistenten gehen.
 * Der Assistent führt sie wie eine Chat-Nachricht mit seinen Werkzeugen aus; Ergebnis und Rückfragen erscheinen im Chat.
 */
export const MAX_TITLE = 120;
export const MAX_PROMPT = 3500;

const COLUMNS = `t.id, t.title, t.prompt, t.agent_id AS "agentId",
  (SELECT a.name FROM agents a WHERE a.id = t.agent_id) AS "agentName", t.created_by AS "createdBy",
  t.run_count AS "runCount", t.last_run_at AS "lastRunAt", t.created_at AS "createdAt",
  t.schedule, t.enabled, t.next_run_at AS "nextRunAt", t.output_target AS "outputTarget", t.run_window AS "runWindow",
  t.last_status AS "lastStatus", t.last_error AS "lastError", t.failure_streak AS "failureStreak", t.template,
  (SELECT json_build_object('status', r.status, 'startedAt', COALESCE(r.started_at, r.queued_at),
            'durationMs', r.duration_ms, 'tokens', r.tokens, 'trigger', r.trigger)
     FROM agent_task_runs r WHERE r.task_id = t.id ORDER BY r.queued_at DESC LIMIT 1) AS "lastRun"`;

/** Verlauf je Aufgabe: so viele Läufe liefert die Verlaufsliste. */
export const RUN_HISTORY_LIMIT = 50;

/** Standard-Aktionen jedes Projekts; beim ersten Start einmalig dem Tester zugewiesen (danach frei änderbar). */
export const DEFAULT_ACTIONS: { title: string; prompt: string }[] = [
  {
    title: 'Tests ausführen',
    prompt:
      'Führe alle Tests des Projekts aus und fasse das Ergebnis zusammen. Ändere nichts, nenne fehlschlagende Tests mit vermuteter Ursache.',
  },
  {
    title: 'Lint und Typprüfung beheben',
    prompt: 'Führe Linter und Typprüfung aus und behebe die gefundenen Fehler, ohne das Verhalten zu ändern.',
  },
  {
    title: 'Abhängigkeiten prüfen',
    prompt:
      'Prüfe veraltete und unsichere Abhängigkeiten (z. B. npm outdated, npm audit) und schlage Updates mit Risiko vor. Nichts installieren.',
  },
  {
    title: 'Docker-Dienste starten',
    prompt:
      'Starte die Docker-Dienste des Projekts (docker compose up -d) und prüfe, ob alle laufen. Melde Fehler mit einem kurzen Log-Auszug.',
  },
  {
    title: 'Logs auf Fehler prüfen',
    prompt: 'Prüfe die Logs der laufenden Dienste auf Fehler und Warnungen der letzten Stunde und fasse sie zusammen.',
  },
  {
    title: 'Git-Status zusammenfassen',
    prompt:
      'Zeige aktuellen Branch, nicht committete Änderungen und Commits, die noch nicht gepusht sind. Nichts ändern.',
  },
];

/**
 * Legt die Standard-Aktionen eines Projekts einmalig an und weist sie dem Tester zu. Ohne Tester-Agent passiert
 * nichts (nächster Versuch beim nächsten Start); gelöschte Aktionen kommen danach nicht wieder.
 */
export async function seedDefaultActions(pool: Pool, project: string): Promise<number> {
  const key = `default_actions_seeded:${project}`;
  if ((await pool.query('SELECT 1 FROM app_settings WHERE key = $1', [key])).rows[0]) return 0;
  const tester = (
    await pool.query<{ id: string }>(
      `SELECT id FROM agents WHERE project_slug = $1 AND role = 'tester' ORDER BY enabled DESC, position LIMIT 1`,
      [project],
    )
  ).rows[0];
  if (!tester) return 0;
  const inserted = await pool.query(
    `INSERT INTO agent_tasks (project_slug, title, prompt, agent_id, created_by)
     SELECT $1, a.title, a.prompt, $2, 'AIdeation'
       FROM unnest($3::text[], $4::text[]) AS a(title, prompt)
      WHERE NOT EXISTS (SELECT 1 FROM agent_tasks t WHERE t.project_slug = $1 AND lower(t.title) = lower(a.title))`,
    [project, tester.id, DEFAULT_ACTIONS.map((action) => action.title), DEFAULT_ACTIONS.map((action) => action.prompt)],
  );
  await pool.query('INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING', [key, 'true']);
  return inserted.rowCount ?? 0;
}

/**
 * Routine-Vorlagen (nächtlicher Sicherheits-Check, Doku-Abgleich …) einmalig je Projekt anlegen – immer deaktiviert
 * und mit Zeitplan, damit sie sich mit einem Klick einschalten lassen. Sie gehören dem allgemeinen Assistenten;
 * gelöschte Vorlagen kommen nicht wieder.
 */
export async function seedRoutineTemplates(pool: Pool, project: string): Promise<number> {
  const key = `routine_templates_seeded:${project}`;
  if ((await pool.query('SELECT 1 FROM app_settings WHERE key = $1', [key])).rows[0]) return 0;
  const inserted = await pool.query(
    `INSERT INTO agent_tasks (project_slug, title, prompt, created_by, schedule, output_target, run_window, template,
                              enabled)
     SELECT p.slug, v.title, v.prompt, 'AIdeation', v.schedule, v.target, NULLIF(v.run_window, ''), v.id, FALSE
       FROM projects p, unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[])
              AS v(id, title, prompt, schedule, target, run_window)
      WHERE p.slug = $1
        AND NOT EXISTS (SELECT 1 FROM agent_tasks t WHERE t.project_slug = $1 AND lower(t.title) = lower(v.title))`,
    [
      project,
      ROUTINE_TEMPLATES.map((template) => template.id),
      ROUTINE_TEMPLATES.map((template) => template.title),
      ROUTINE_TEMPLATES.map((template) => template.prompt),
      ROUTINE_TEMPLATES.map((template) => template.schedule),
      ROUTINE_TEMPLATES.map((template) => template.outputTarget),
      ROUTINE_TEMPLATES.map((template) => template.runWindow ?? ''),
    ],
  );
  await pool.query('INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING', [key, 'true']);
  return inserted.rowCount ?? 0;
}

export interface ParsedTask {
  title: string;
  prompt: string;
  agentId: string | null;
  /** Nur gesetzt, wenn die Anfrage den Zeitplan mitschickt (null = kein Zeitplan); sonst bleibt er unverändert. */
  schedule?: string | null;
  outputTarget?: OutputTarget;
  runWindow?: string | null;
  enabled?: boolean;
}

/** Prüft Titel, Anweisung, Agent und – falls mitgeschickt – Zeitplan (Cron, 5 Felder), Ziel und Zeitfenster. */
export function parseTask(body: unknown): ParsedTask | string {
  const record = (body ?? {}) as Record<string, unknown>;
  const title = typeof record.title === 'string' ? record.title.trim() : '';
  const prompt = typeof record.prompt === 'string' ? record.prompt.trim() : '';
  if (!title || title.length > MAX_TITLE) return `Titel erforderlich (max. ${MAX_TITLE} Zeichen).`;
  if (!prompt || prompt.length > MAX_PROMPT) return `Anweisung erforderlich (max. ${MAX_PROMPT} Zeichen).`;
  if (record.agentId !== undefined && record.agentId !== null && !isUuid(record.agentId)) return 'Ungültiger Agent.';
  const task: ParsedTask = { title, prompt, agentId: isUuid(record.agentId) ? record.agentId : null };
  if (record.schedule !== undefined) {
    const schedule = typeof record.schedule === 'string' ? record.schedule.trim().replace(/\s+/g, ' ') : '';
    if (record.schedule !== null && typeof record.schedule !== 'string') return 'Ungültiger Zeitplan.';
    if (schedule) {
      const cron = parseCron(schedule);
      if (typeof cron === 'string') return cron;
      if (!nextCronRun(cron, new Date())) return 'Der Zeitplan trifft nie zu.';
    }
    task.schedule = schedule || null;
  }
  if (record.outputTarget !== undefined) {
    if (!OUTPUT_TARGETS.includes(record.outputTarget as OutputTarget)) return 'Ungültiges Ziel für das Ergebnis.';
    task.outputTarget = record.outputTarget as OutputTarget;
  }
  if (record.runWindow !== undefined) {
    const window = typeof record.runWindow === 'string' ? record.runWindow.replace(/\s+/g, '') : '';
    if (record.runWindow !== null && typeof record.runWindow !== 'string') return 'Ungültiges Zeitfenster.';
    const parsed = parseWindow(window);
    if (typeof parsed === 'string') return parsed;
    task.runWindow = parsed ? window : null;
  }
  if (record.enabled !== undefined) {
    if (typeof record.enabled !== 'boolean') return 'Ungültiger Wert für „aktiv“.';
    task.enabled = record.enabled;
  }
  return task;
}

/** Nächster Lauf (Europe/Zurich) – dieselbe Berechnung für API, Planer und Vorlagen. */
export function computeNextRun(
  task: { schedule: string | null; runWindow: string | null; enabled: boolean },
  now = new Date(),
): Date | null {
  return task.schedule && task.enabled ? nextRoutineRun(task.schedule, task.runWindow, now) : null;
}

/** Der gewählte Agent muss zum Projekt gehören. */
async function agentInProject(pool: Pool, agentId: string | null, slug: string): Promise<boolean> {
  if (!agentId) return true;
  return !!(await pool.query('SELECT 1 FROM agents WHERE id = $1 AND project_slug = $2', [agentId, slug])).rows[0];
}

export { taskMessage };

const notFound = (response: Response): void => void response.status(404).json({ message: 'Aufgabe nicht gefunden.' });

export function registerAgentTaskRoutes(app: Router, pool: Pool): void {
  const me = (response: Response) => response.locals.principal as Principal | undefined;

  app.get('/projects/:slug/agent-tasks', access({ tenant: 'project' }), async (request, response, next) => {
    try {
      const slug = parseProjectSlug(request.params.slug ?? '');
      if (!slug) return void response.status(400).json({ message: 'Ungültiges Projekt.' });
      const tasks = (
        await pool.query(
          `SELECT ${COLUMNS} FROM agent_tasks t WHERE t.project_slug = $1
            ORDER BY t.last_run_at DESC NULLS LAST, lower(t.title)`,
          [slug],
        )
      ).rows;
      response.json({ tasks });
    } catch (error) {
      next(error);
    }
  });

  app.post(
    '/projects/:slug/agent-tasks',
    access({ role: 'chat', tenant: 'project' }),
    async (request, response, next) => {
      try {
        const slug = parseProjectSlug(request.params.slug ?? '');
        const task = parseTask(request.body);
        if (!slug) return void response.status(400).json({ message: 'Ungültiges Projekt.' });
        if (typeof task === 'string') return void response.status(400).json({ message: task });
        if (!(await agentInProject(pool, task.agentId, slug))) {
          return void response.status(400).json({ message: 'Agent gehört nicht zum Projekt.' });
        }
        const schedule = task.schedule ?? null;
        const runWindow = task.runWindow ?? null;
        const enabled = task.enabled ?? true;
        const row = (
          await pool.query(
            `WITH t AS (INSERT INTO agent_tasks (project_slug, title, prompt, agent_id, created_by, schedule, output_target,
                                               run_window, enabled, next_run_at)
             SELECT slug, $2, $3, $4, $5, $6, $7, $8, $9, $10 FROM projects WHERE slug = $1 RETURNING *)
           SELECT ${COLUMNS} FROM t`,
            [
              slug,
              task.title,
              task.prompt,
              task.agentId,
              me(response)?.displayName ?? null,
              schedule,
              task.outputTarget ?? 'chat',
              runWindow,
              enabled,
              computeNextRun({ schedule, runWindow, enabled }),
            ],
          )
        ).rows[0];
        if (!row) return void response.status(404).json({ message: 'Projekt nicht gefunden.' });
        response.status(201).json(row);
      } catch (error) {
        next(error);
      }
    },
  );

  app.patch('/agent-tasks/:id', access({ role: 'chat', tenant: 'agent-tasks' }), async (request, response, next) => {
    try {
      const task = parseTask(request.body);
      if (!isUuid(request.params.id)) return notFound(response);
      if (typeof task === 'string') return void response.status(400).json({ message: task });
      const current = (
        await pool.query<{
          slug: string;
          schedule: string | null;
          runWindow: string | null;
          enabled: boolean;
          outputTarget: OutputTarget;
        }>(
          `SELECT project_slug AS slug, schedule, run_window AS "runWindow", enabled, output_target AS "outputTarget"
             FROM agent_tasks WHERE id = $1`,
          [request.params.id],
        )
      ).rows[0];
      if (!current) return notFound(response);
      if (!(await agentInProject(pool, task.agentId, current.slug))) {
        return void response.status(400).json({ message: 'Agent gehört nicht zum Projekt.' });
      }
      // Nicht mitgeschickte Zeitplan-Felder bleiben (z. B. Bearbeiten auf der Agents-Seite ohne Zeitplan-Auswahl).
      const schedule = task.schedule === undefined ? current.schedule : task.schedule;
      const runWindow = task.runWindow === undefined ? current.runWindow : task.runWindow;
      const enabled = task.enabled ?? current.enabled;
      const reactivated = enabled && !current.enabled;
      const row = (
        await pool.query(
          `WITH t AS (UPDATE agent_tasks SET title = $2, prompt = $3, agent_id = $4, schedule = $5, run_window = $6,
                        enabled = $7, output_target = $8, next_run_at = $9,
                        failure_streak = CASE WHEN $10 THEN 0 ELSE failure_streak END,
                        last_error = CASE WHEN $10 THEN NULL ELSE last_error END
                      WHERE id = $1 RETURNING *)
           SELECT ${COLUMNS} FROM t`,
          [
            request.params.id,
            task.title,
            task.prompt,
            task.agentId,
            schedule,
            runWindow,
            enabled,
            task.outputTarget ?? current.outputTarget,
            computeNextRun({ schedule, runWindow, enabled }),
            reactivated,
          ],
        )
      ).rows[0];
      if (!row) return notFound(response);
      response.json(row);
    } catch (error) {
      next(error);
    }
  });

  app.delete('/agent-tasks/:id', access({ role: 'chat', tenant: 'agent-tasks' }), async (request, response, next) => {
    try {
      if (!isUuid(request.params.id)) return void response.status(404).json({ message: 'Aufgabe nicht gefunden.' });
      await pool.query('DELETE FROM agent_tasks WHERE id = $1', [request.params.id]);
      response.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  // Ein Klick: Aufgabe als Nachricht an den Assistenten des Projekts übergeben.
  app.post('/agent-tasks/:id/run', access({ role: 'chat', tenant: 'agent-tasks' }), async (request, response, next) => {
    try {
      if (!isUuid(request.params.id)) return notFound(response);
      const task = (
        await pool.query<{ id: string; projectSlug: string; title: string; prompt: string; agentId: string | null }>(
          `SELECT id, project_slug AS "projectSlug", title, prompt, agent_id AS "agentId" FROM agent_tasks WHERE id = $1`,
          [request.params.id],
        )
      ).rows[0];
      if (!task) return notFound(response);
      // Auch ein Klick ist ein Lauf im Protokoll (Start, Dauer, Ergebnis, Tokens).
      const { message } = await queueRun(
        pool,
        task,
        'manual',
        taskMessage(
          task,
          isRecord(request.body) && typeof request.body.comment === 'string' ? request.body.comment : '',
        ),
      );
      response.status(201).json(message);
    } catch (error) {
      next(error);
    }
  });

  // Verlauf: die letzten Läufe mit Start, Dauer, Ergebnis, Tokens, Hinweisen und angelegten Einträgen.
  app.get('/agent-tasks/:id/runs', access({ tenant: 'agent-tasks' }), async (request, response, next) => {
    try {
      if (!isUuid(request.params.id)) return notFound(response);
      const runs = (
        await pool.query(
          `SELECT id, trigger, status, environment_error AS "environmentError", queued_at AS "queuedAt",
                  started_at AS "startedAt", finished_at AS "finishedAt", duration_ms AS "durationMs", tokens::int,
                  error, notes, created_items AS "createdItems", message_id AS "messageId", answer_id AS "answerId"
             FROM agent_task_runs WHERE task_id = $1 ORDER BY queued_at DESC LIMIT $2`,
          [request.params.id, RUN_HISTORY_LIMIT],
        )
      ).rows;
      response.json({ runs });
    } catch (error) {
      next(error);
    }
  });

  // Pausieren: kein nächster Lauf; wartende Läufe werden abgebrochen (zählt nicht als Fehlschlag).
  app.post(
    '/agent-tasks/:id/pause',
    access({ role: 'chat', tenant: 'agent-tasks' }),
    async (request, response, next) => {
      try {
        if (!isUuid(request.params.id)) return notFound(response);
        const row = (
          await pool.query(
            `WITH t AS (UPDATE agent_tasks SET enabled = FALSE, last_error = COALESCE($2, last_error)
                      WHERE id = $1 RETURNING *)
           SELECT ${COLUMNS} FROM t`,
            [request.params.id, `Pausiert von ${me(response)?.displayName ?? 'Benutzer'}.`],
          )
        ).rows[0];
        if (!row) return notFound(response);
        const cancelled = await pool.query<{ messageId: string | null }>(
          `UPDATE agent_task_runs SET status = 'cancelled', finished_at = NOW(), error = 'Vom Benutzer pausiert.'
          WHERE task_id = $1 AND status = 'queued' RETURNING message_id AS "messageId"`,
          [request.params.id],
        );
        const messages = cancelled.rows.map((run) => run.messageId).filter(Boolean);
        if (messages.length) {
          await pool.query(`DELETE FROM chat_messages WHERE id = ANY($1::uuid[]) AND status = 'pending'`, [messages]);
        }
        response.json(row);
      } catch (error) {
        next(error);
      }
    },
  );

  // Fortsetzen: Zählung zurücksetzen, Pausengrund löschen, nächsten Lauf neu berechnen.
  app.post(
    '/agent-tasks/:id/resume',
    access({ role: 'chat', tenant: 'agent-tasks' }),
    async (request, response, next) => {
      try {
        if (!isUuid(request.params.id)) return notFound(response);
        const current = (
          await pool.query<{ schedule: string | null; runWindow: string | null }>(
            `SELECT schedule, run_window AS "runWindow" FROM agent_tasks WHERE id = $1`,
            [request.params.id],
          )
        ).rows[0];
        if (!current) return notFound(response);
        const row = (
          await pool.query(
            `WITH t AS (UPDATE agent_tasks SET enabled = TRUE, failure_streak = 0, last_error = NULL, next_run_at = $2
                      WHERE id = $1 RETURNING *)
           SELECT ${COLUMNS} FROM t`,
            [request.params.id, computeNextRun({ ...current, enabled: true })],
          )
        ).rows[0];
        if (!row) return notFound(response);
        response.json(row);
      } catch (error) {
        next(error);
      }
    },
  );
}
