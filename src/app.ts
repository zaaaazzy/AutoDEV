import { timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import express, { type Express, type RequestHandler } from 'express';
import type { Pool } from 'pg';
import { ensureDefaultAgents, registerAgentRoutes } from './agents.js';
import { registerAttachmentRoutes } from './attachments.js';
import { registerBugRoutes } from './bugs.js';
import { registerChatRoutes } from './chat-routes.js';
import { registerDocRoutes } from './docs.js';
import { registerReportRoutes } from './reports.js';
import { registerSprintRoutes } from './sprints.js';
import { isValidGitRemote } from './git-sync.js';
import { registerStatsRoutes } from './stats.js';
import { registerWorkerRoutes } from './worker.js';
import {
  buildUpdate, ESTIMATE_FIELDS, isRecord, isUuid, PRIORITIES, PROJECT_SLUG, parseFields, parseLongText,
  parseNullableUuid, parseOption, parseProjectSlug, parseTitle, validStatus, validText,
} from './validation.js';

const UI_DIRECTORY = join(import.meta.dirname, '..', 'dist', 'ui', 'browser');
// Manuell setzbar; „requested“, „drafting“ und „accepted“ ergeben sich aus dem Ablauf („Auftrag erstellen“).
const IDEATION_STATUSES = new Set(['idea', 'considering']);
const DEVELOPMENT_STATUSES = new Set(['backlog', 'planned', 'in_progress', 'blocked', 'done']);

export interface DevLogAuth {
  username: string;
  password: string;
}

function equalSecret(received: string, expected: string): boolean {
  const actualBuffer = Buffer.from(received);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function isAuthorized(requestAuthorization: string | undefined, auth: DevLogAuth): boolean {
  if (!requestAuthorization?.startsWith('Basic ')) {
    return false;
  }
  try {
    const decoded = Buffer.from(requestAuthorization.slice(6), 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    return separator >= 0
      && equalSecret(decoded.slice(0, separator), auth.username)
      && equalSecret(decoded.slice(separator + 1), auth.password);
  } catch {
    return false;
  }
}

function requireCredentials(auth: DevLogAuth): RequestHandler {
  return (request, response, next) => {
    response.set('Cache-Control', 'no-store');
    if (!isAuthorized(request.get('authorization'), auth)) {
      response.set('WWW-Authenticate', 'Basic realm="Mainty Dev Log", charset="UTF-8"');
      response.status(401).send('Authentication required.');
      return;
    }
    next();
  };
}

export function createDevLogApp(pool: Pool, auth: DevLogAuth | null): Express {
  const app = express();
  app.disable('x-powered-by');
  app.get('/health', (_request, response) => response.json({ status: 'ok' }));
  app.use(express.json({ limit: '32kb' }));
  if (auth) {
    app.use(requireCredentials(auth));
  }
  app.use(express.static(UI_DIRECTORY, { index: false }));
  app.get('/', async (_request, response) => {
    response.sendFile(join(UI_DIRECTORY, 'index.html'));
  });

  app.get('/api/projects', async (_request, response) => {
    const result = await pool.query(
      `SELECT slug, name, repository, git_remote AS "gitRemote", test_commands AS "testCommands", description, guidelines, created_at AS "createdAt"
         FROM projects
        ORDER BY name`,
    );
    response.json({ projects: result.rows });
  });

  app.patch('/api/projects/:slug', async (request, response) => {
    const slug = parseProjectSlug(request.params.slug ?? '');
    const body: Record<string, unknown> = isRecord(request.body) ? request.body : {};
    const sets: string[] = [];
    const values: unknown[] = [slug];
    const fail = (message: string): void => {
      response.status(400).json({ message });
    };
    if (!slug) {
      return fail('Ungültiges Projekt.');
    }
    if (body.gitRemote !== undefined) {
      const remote = typeof body.gitRemote === 'string' ? body.gitRemote.trim() : null;
      if (remote === null || (remote !== '' && !isValidGitRemote(remote))) {
        return fail('Ungültige Repository-URL. Erlaubt: https://github.com/<user>/<repo>.git oder git@github.com:<user>/<repo>.git – ohne Zugangsdaten in der URL.');
      }
      values.push(remote || null);
      sets.push(`git_remote = $${values.length}`);
    }
    if (body.repository !== undefined) {
      const folder = typeof body.repository === 'string' ? body.repository.trim() : '';
      if (!folder.startsWith('/') || folder.length > 500) {
        return fail('Projektordner muss ein absoluter Pfad sein, z. B. /Users/name/projekte/mein-projekt.');
      }
      values.push(folder);
      sets.push(`repository = $${values.length}`);
    }
    if (body.testCommands !== undefined) {
      let commands: string[][] | null = null;
      if (typeof body.testCommands === 'string' && body.testCommands.trim()) {
        commands = body.testCommands.trim().split('\n').filter((line) => line.trim()).map((line) => line.trim().split(/\s+/));
      } else if (body.testCommands === null || body.testCommands === '') {
        commands = null;
      } else {
        return fail('Testbefehle: ein Befehl pro Zeile, z. B. „npm test“.');
      }
      values.push(commands ? JSON.stringify(commands) : null);
      sets.push(`test_commands = $${values.length}::jsonb`);
    }
    for (const key of ['description', 'guidelines'] as const) {
      if (body[key] === undefined) continue;
      if (typeof body[key] !== 'string' || body[key].length > 10_000) {
        return fail('Projektbeschreibung und Regeln dürfen höchstens 10000 Zeichen lang sein.');
      }
      values.push(body[key].trim());
      sets.push(`${key} = $${values.length}`);
    }
    if (!sets.length) {
      return fail('Keine Änderung angegeben.');
    }
    const result = await pool.query(
      `UPDATE projects SET ${sets.join(', ')} WHERE slug = $1 RETURNING slug, name, repository, git_remote AS "gitRemote", test_commands AS "testCommands", description, guidelines`,
      values,
    );
    if (!result.rows[0]) {
      response.status(404).json({ message: 'Projekt nicht gefunden.' });
      return;
    }
    response.json({ project: result.rows[0] });
  });

  app.post('/api/projects', async (request, response) => {
    const body = request.body as unknown;
    if (!isRecord(body) || typeof body.slug !== 'string' || !PROJECT_SLUG.test(body.slug)
      || !validText(body.name, 120)
      || !validText(body.repository, 500)) {
      response.status(400).json({ message: 'Project slug, name, and repository are required.' });
      return;
    }
    const result = await pool.query(
      `INSERT INTO projects (slug, name, repository)
       VALUES ($1, $2, $3)
       ON CONFLICT (slug) DO UPDATE
         SET name = EXCLUDED.name, repository = EXCLUDED.repository
       RETURNING slug, name, repository, created_at AS "createdAt"`,
      [body.slug, body.name.trim(), body.repository.trim()],
    );
    await ensureDefaultAgents(pool, body.slug);
    response.status(201).json({ project: result.rows[0] });
  });

  app.get('/api/projects/:slug/test-runs', async (request, response) => {
    const slug = parseProjectSlug(request.params.slug ?? '');
    if (!slug) {
      response.status(400).json({ message: 'Invalid project slug.' });
      return;
    }
    const runs = await pool.query(
      `SELECT id, status, trigger, branch, commit_sha AS "commitSha",
              started_at AS "startedAt", completed_at AS "completedAt"
         FROM test_runs
        WHERE project_slug = $1
        ORDER BY started_at DESC
        LIMIT 50`,
      [slug],
    );
    const steps = await pool.query(
      `SELECT s.run_id AS "runId", s.position, s.command, s.status,
              s.exit_code AS "exitCode", s.duration_ms AS "durationMs", s.output
         FROM test_run_steps s
         JOIN test_runs r ON r.id = s.run_id
        WHERE r.project_slug = $1
          AND r.id = ANY($2::uuid[])
        ORDER BY r.started_at DESC, s.position`,
      [slug, runs.rows.map((run) => run.id)],
    );
    response.json({
      runs: runs.rows.map((run) => ({
        ...run,
        steps: steps.rows.filter((step) => step.runId === run.id),
      })),
    });
  });

  const IDEA_COLUMNS = `id, title, description, status, priority, created_at AS "createdAt",
    effort_hours AS "effortHours", token_estimate AS "tokenEstimate", benefit, cost,
    agent_note AS "agentNote"`;
  const DEV_COLUMNS = `id, ideation_id AS "ideationId", test_run_id AS "testRunId", sprint_id AS "sprintId",
    title, description, status, priority, created_at AS "createdAt",
    effort_hours AS "effortHours", token_estimate AS "tokenEstimate", benefit, cost,
    kind, bug_id AS "bugId", completed_at AS "completedAt", agent_id AS "agentId"`;
  const IDEA_FIELDS = {
    title: { column: 'title', parse: parseTitle(180) },
    description: { column: 'description', parse: parseLongText },
    status: { column: 'status', parse: parseOption(IDEATION_STATUSES) },
    priority: { column: 'priority', parse: parseOption(PRIORITIES) },
    ...ESTIMATE_FIELDS,
  };
  const DEV_FIELDS = {
    ...IDEA_FIELDS,
    status: { column: 'status', parse: parseOption(DEVELOPMENT_STATUSES) },
    sprintId: { column: 'sprint_id', parse: parseNullableUuid },
    agentId: { column: 'agent_id', parse: parseNullableUuid },
  };

  app.get('/api/projects/:slug/board', async (request, response) => {
    const slug = parseProjectSlug(request.params.slug ?? '');
    if (!slug) {
      response.status(400).json({ message: 'Invalid project slug.' });
      return;
    }
    const [ideas, development, comments] = await Promise.all([
      pool.query(
        `SELECT ${IDEA_COLUMNS} FROM ideation_items WHERE project_slug = $1
          ORDER BY created_at DESC LIMIT 200`,
        [slug],
      ),
      pool.query(
        `SELECT ${DEV_COLUMNS} FROM development_items WHERE project_slug = $1
          ORDER BY created_at DESC LIMIT 200`,
        [slug],
      ),
      pool.query(
        `SELECT c.id, c.ideation_id AS "ideationId", c.author, c.body, c.created_at AS "createdAt"
           FROM ideation_comments c JOIN ideation_items i ON i.id = c.ideation_id
          WHERE i.project_slug = $1 ORDER BY c.created_at`,
        [slug],
      ),
    ]);
    response.json({ ideas: ideas.rows, development: development.rows, comments: comments.rows });
  });

  app.post('/api/projects/:slug/ideation', async (request, response) => {
    const slug = parseProjectSlug(request.params.slug ?? '');
    const body = request.body as unknown;
    const fields = parseFields(body, IDEA_FIELDS);
    if (!slug || !fields || !isRecord(body) || body.title === undefined) {
      response.status(400).json({ message: 'Invalid ideation item.' });
      return;
    }
    const values = new Map(fields.map((field) => [field.column, field.value]));
    const result = await pool.query(
      `INSERT INTO ideation_items (project_slug, title, description, status, priority,
                                   effort_hours, token_estimate, benefit, cost)
       VALUES ($1, $2, $3, COALESCE($4, 'idea'), COALESCE($5, 'medium'), $6, $7, $8, $9)
       RETURNING ${IDEA_COLUMNS}`,
      [slug, values.get('title'), values.get('description') ?? '', values.get('status') ?? null,
        values.get('priority') ?? null, values.get('effort_hours') ?? null, values.get('token_estimate') ?? null,
        values.get('benefit') ?? null, values.get('cost') ?? null],
    );
    response.status(201).json({ item: result.rows[0] });
  });

  app.patch('/api/ideation/:id', async (request, response) => {
    if (!isUuid(request.params.id)) {
      response.status(404).json({ message: 'Not found.' });
      return;
    }
    const fields = parseFields(request.body, IDEA_FIELDS);
    if (!fields) {
      response.status(400).json({ message: 'Invalid ideation update.' });
      return;
    }
    const update = buildUpdate('ideation_items', request.params.id, fields,
      `${IDEA_COLUMNS}, project_slug AS "projectSlug"`);
    const result = await pool.query(update.sql, update.values);
    if (!result.rows[0]) {
      response.status(404).json({ message: 'Ideation item not found.' });
      return;
    }
    response.json({ item: result.rows[0] });
  });

  // „Auftrag erstellen“: Der Auftragsautor formuliert den Auftrag aus. Nur aus „Idee“ oder „In Abklärung“ möglich.
  app.post('/api/ideation/:id/define', async (request, response) => {
    if (!isUuid(request.params.id)) {
      response.status(404).json({ message: 'Not found.' });
      return;
    }
    const result = await pool.query(
      `UPDATE ideation_items SET status = 'requested', agent_note = NULL, updated_at = NOW()
        WHERE id = $1 AND status IN ('idea', 'considering') RETURNING ${IDEA_COLUMNS}, project_slug AS "projectSlug"`,
      [request.params.id],
    );
    if (!result.rows[0]) {
      response.status(409).json({ message: 'Die Idee ist nicht mehr in Bearbeitung durch Menschen.' });
      return;
    }
    response.json({ item: result.rows[0] });
  });

  app.post('/api/ideation/:id/comments', async (request, response) => {
    const text = isRecord(request.body) && typeof request.body.body === 'string' ? request.body.body.trim() : '';
    if (!isUuid(request.params.id) || !text || text.length > 4000) {
      response.status(400).json({ message: 'Bitte einen Kommentar eingeben (max. 4000 Zeichen).' });
      return;
    }
    const encoded = /^Basic (.+)$/.exec(request.headers.authorization ?? '')?.[1] ?? '';
    const author = Buffer.from(encoded, 'base64').toString().split(':')[0]?.slice(0, 60) || 'Nutzer';
    const result = await pool.query(
      `INSERT INTO ideation_comments (ideation_id, author, body)
       SELECT id, $2, $3 FROM ideation_items WHERE id = $1
       RETURNING id, ideation_id AS "ideationId", author, body, created_at AS "createdAt"`,
      [request.params.id, author, text],
    );
    if (!result.rows[0]) {
      response.status(404).json({ message: 'Idee nicht gefunden.' });
      return;
    }
    response.status(201).json({ item: result.rows[0] });
  });

  // Turns an idea into a backlog order; sprint or agent are assigned to the order afterwards.
  app.post('/api/ideation/:id/promote', async (request, response) => {
    if (!isUuid(request.params.id)) {
      response.status(400).json({ message: 'Invalid idea.' });
      return;
    }
    const result = await pool.query(
      `INSERT INTO development_items (project_slug, ideation_id, title, description, status, priority,
                                      effort_hours, token_estimate, benefit, cost)
       SELECT i.project_slug, i.id, i.title, i.description, 'backlog', i.priority,
              i.effort_hours, i.token_estimate, i.benefit, i.cost
         FROM ideation_items i
        WHERE i.id = $1
          AND NOT EXISTS (SELECT 1 FROM development_items d WHERE d.ideation_id = i.id)
       RETURNING ${DEV_COLUMNS}`,
      [request.params.id],
    );
    if (!result.rows[0]) {
      response.status(409).json({ message: 'Idee nicht gefunden oder bereits als Auftrag übernommen.' });
      return;
    }
    await pool.query(
      `UPDATE ideation_items SET status = 'accepted', updated_at = NOW() WHERE id = $1`,
      [request.params.id],
    );
    response.status(201).json({ item: result.rows[0] });
  });

  app.post('/api/projects/:slug/development', async (request, response) => {
    const slug = parseProjectSlug(request.params.slug ?? '');
    const body = request.body as unknown;
    if (!slug || !isRecord(body) || !validText(body.title, 180)
      || (body.description !== undefined && (typeof body.description !== 'string' || body.description.length > 10_000))
      || (body.status !== undefined && !validStatus(body.status, DEVELOPMENT_STATUSES))
      || (body.priority !== undefined && !validStatus(body.priority, PRIORITIES))
      || (body.ideationId !== undefined && !isUuid(body.ideationId))
      || (body.testRunId !== undefined && !isUuid(body.testRunId))) {
      response.status(400).json({ message: 'Invalid development item.' });
      return;
    }
    const result = await pool.query(
      `INSERT INTO development_items (project_slug, ideation_id, test_run_id, title, description, status, priority)
       SELECT $1, i.id, tr.id, $4, $5, COALESCE($6, 'backlog'), COALESCE($7, 'medium')
         FROM (SELECT 1) seed
         LEFT JOIN ideation_items i ON i.id = $2 AND i.project_slug = $1
         LEFT JOIN test_runs tr ON tr.id = $3 AND tr.project_slug = $1
        WHERE ($2::uuid IS NULL OR i.id IS NOT NULL)
          AND ($3::uuid IS NULL OR tr.id IS NOT NULL)
       RETURNING ${DEV_COLUMNS}`,
      [slug, body.ideationId ?? null, body.testRunId ?? null, body.title.trim(),
        typeof body.description === 'string' ? body.description.trim() : '',
        body.status ?? null, body.priority ?? null],
    );
    if (!result.rows[0]) {
      response.status(400).json({ message: 'Linked ideation or test run does not belong to this project.' });
      return;
    }
    response.status(201).json({ item: result.rows[0] });
  });

  app.patch('/api/development/:id', async (request, response) => {
    if (!isUuid(request.params.id)) {
      response.status(404).json({ message: 'Not found.' });
      return;
    }
    const fields = parseFields(request.body, DEV_FIELDS);
    if (!fields) {
      response.status(400).json({ message: 'Invalid development update.' });
      return;
    }
    const sprintId = fields.find((field) => field.column === 'sprint_id')?.value;
    if (typeof sprintId === 'string') {
      const sameProject = await pool.query(
        `SELECT 1 FROM sprints s JOIN development_items d ON d.project_slug = s.project_slug
          WHERE s.id = $1 AND d.id = $2`,
        [sprintId, request.params.id],
      );
      if (!sameProject.rows[0]) {
        response.status(400).json({ message: 'Sprint does not belong to the project of this item.' });
        return;
      }
    }
    const agentId = fields.find((field) => field.column === 'agent_id')?.value;
    if (typeof agentId === 'string') {
      const sameProject = await pool.query(
        `SELECT 1 FROM agents a JOIN development_items d ON d.project_slug = a.project_slug
          WHERE a.id = $1 AND d.id = $2`,
        [agentId, request.params.id],
      );
      if (!sameProject.rows[0]) {
        response.status(400).json({ message: 'Agent does not belong to the project of this item.' });
        return;
      }
    }
    const sprintField = fields.find((field) => field.column === 'sprint_id');
    const agentField = fields.find((field) => field.column === 'agent_id');
    const update = buildUpdate('development_items', request.params.id, fields,
      `${DEV_COLUMNS}, project_slug AS "projectSlug"`);
    const manualStart = typeof agentId === 'string' && !fields.some((field) => field.column === 'status');
    if ((sprintField || agentField) && !manualStart && !fields.some((field) => field.column === 'status')) {
      // Assigning a backlog order to a sprint or an agent plans it; removing both returns it to the backlog.
      const assigned = (sprintField ?? agentField)?.value !== null;
      update.sql = update.sql.replace(', updated_at = NOW()',
        `, status = CASE WHEN status IN ('backlog', 'planned') THEN ${assigned ? "'planned'" : `CASE WHEN ${sprintField ? 'agent_id' : 'sprint_id'} IS NULL THEN 'backlog' ELSE 'planned' END`} ELSE status END, updated_at = NOW()`);
    }
    if (manualStart) {
      // Manueller Start eines einzelnen Agents (auch bei erledigten oder blockierten Aufträgen): Der vorherige Status wird nach dem Lauf wiederhergestellt.
      update.sql = update.sql.replace(', updated_at = NOW()',
        `, return_status = CASE WHEN status IN ('backlog', 'blocked', 'done') THEN COALESCE(return_status, status) ELSE return_status END,
          status = CASE WHEN status IN ('backlog', 'blocked', 'done') THEN 'planned' ELSE status END, updated_at = NOW()`);
    }
    const result = await pool.query(update.sql, update.values);
    if (!result.rows[0]) {
      response.status(404).json({ message: 'Development item not found.' });
      return;
    }
    response.json({ item: result.rows[0] });
  });

  app.get('/api/projects/:slug/agent-runs', async (request, response) => {
    const slug = parseProjectSlug(request.params.slug ?? '');
    if (!slug) {
      response.status(400).json({ message: 'Invalid project slug.' });
      return;
    }
    const runs = await pool.query(
      `SELECT id, development_id AS "developmentId", status, started_at AS "startedAt", completed_at AS "completedAt"
         FROM agent_runs WHERE project_slug = $1 ORDER BY started_at DESC LIMIT 30`,
      [slug],
    );
    const steps = await pool.query(
      `SELECT run_id AS "runId", position, agent_name AS "agentName", phase, status,
              exit_code AS "exitCode", duration_ms AS "durationMs", output
         FROM agent_run_steps WHERE run_id = ANY($1::uuid[]) ORDER BY run_id, position`,
      [runs.rows.map((run) => run.id)],
    );
    response.json({
      runs: runs.rows.map((run) => ({ ...run, steps: steps.rows.filter((step) => step.runId === run.id) })),
    });
  });

  registerSprintRoutes(app, pool);
  registerAgentRoutes(app, pool);
  registerBugRoutes(app, pool);
  registerAttachmentRoutes(app, pool);
  registerDocRoutes(app, pool);
  registerReportRoutes(app, pool);
  registerStatsRoutes(app, pool);
  registerChatRoutes(app, pool);
  registerWorkerRoutes(app, pool);

  app.get('*splat', (_request, response) => response.status(404).json({ message: 'Not found.' }));
  return app;
}
