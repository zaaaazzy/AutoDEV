import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import express, { type Express, type RequestHandler } from 'express';
import type { Pool } from 'pg';
import { ensureDefaultAgents, registerAgentRoutes } from './agents.js';
import { registerBugRoutes } from './bugs.js';
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

const PUBLIC_DIRECTORY = join(import.meta.dirname, '..', 'public');
const IDEATION_STATUSES = new Set(['idea', 'considering', 'requested', 'drafting', 'accepted', 'rejected']);
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
  app.get('/', async (_request, response) => {
    response.type('html').send(await readFile(join(PUBLIC_DIRECTORY, 'index.html'), 'utf8'));
  });
  app.get('/styles.css', (_request, response) => response.sendFile(join(PUBLIC_DIRECTORY, 'styles.css')));
  app.get('/app.js', (_request, response) => response.sendFile(join(PUBLIC_DIRECTORY, 'app.js')));

  app.get('/api/projects', async (_request, response) => {
    const result = await pool.query(
      `SELECT slug, name, repository, git_remote AS "gitRemote", test_commands AS "testCommands", created_at AS "createdAt"
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
    if (!sets.length) {
      return fail('Keine Änderung angegeben.');
    }
    const result = await pool.query(
      `UPDATE projects SET ${sets.join(', ')} WHERE slug = $1 RETURNING slug, name, repository, git_remote AS "gitRemote", test_commands AS "testCommands"`,
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
    kind, bug_id AS "bugId", completed_at AS "completedAt"`;
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
  };

  app.get('/api/projects/:slug/board', async (request, response) => {
    const slug = parseProjectSlug(request.params.slug ?? '');
    if (!slug) {
      response.status(400).json({ message: 'Invalid project slug.' });
      return;
    }
    const [ideas, development] = await Promise.all([
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
    ]);
    response.json({ ideas: ideas.rows, development: development.rows });
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
       VALUES ($1, $2, $3, COALESCE($4, 'requested'), COALESCE($5, 'medium'), $6, $7, $8, $9)
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

  // Asks the author agent to rewrite the requirement of an idea according to a change request.
  app.post('/api/ideation/:id/revise', async (request, response) => {
    const prompt = isRecord(request.body) && typeof request.body.prompt === 'string' ? request.body.prompt.trim() : '';
    if (!isUuid(request.params.id) || !prompt || prompt.length > 4000) {
      response.status(400).json({ message: 'Bitte beschreibe, was geändert werden soll (max. 4000 Zeichen).' });
      return;
    }
    const result = await pool.query(
      `UPDATE ideation_items SET revision_prompt = $2, status = 'requested', agent_note = NULL, updated_at = NOW()
        WHERE id = $1 AND status <> 'drafting' RETURNING ${IDEA_COLUMNS}`,
      [request.params.id, prompt],
    );
    if (!result.rows[0]) {
      response.status(409).json({ message: 'Idee nicht gefunden oder der Agent arbeitet gerade daran.' });
      return;
    }
    response.json({ item: result.rows[0] });
  });

  // Turns an idea into a development order, optionally assigned to a sprint of the same project.
  app.post('/api/ideation/:id/promote', async (request, response) => {
    const body = request.body as unknown;
    const sprintId = isRecord(body) && body.sprintId !== undefined ? body.sprintId : null;
    if (!isUuid(request.params.id) || (sprintId !== null && !isUuid(sprintId))) {
      response.status(400).json({ message: 'Invalid idea or sprint.' });
      return;
    }
    const result = await pool.query(
      `INSERT INTO development_items (project_slug, ideation_id, sprint_id, title, description, status, priority,
                                      effort_hours, token_estimate, benefit, cost)
       SELECT i.project_slug, i.id, s.id, i.title, i.description,
              CASE WHEN s.id IS NULL THEN 'backlog' ELSE 'planned' END, i.priority,
              i.effort_hours, i.token_estimate, i.benefit, i.cost
         FROM ideation_items i
         LEFT JOIN sprints s ON s.id = $2 AND s.project_slug = i.project_slug
        WHERE i.id = $1
          AND ($2::uuid IS NULL OR s.id IS NOT NULL)
          AND NOT EXISTS (SELECT 1 FROM development_items d WHERE d.ideation_id = i.id)
       RETURNING ${DEV_COLUMNS}`,
      [request.params.id, sprintId],
    );
    if (!result.rows[0]) {
      response.status(409).json({
        message: 'Idee nicht gefunden, bereits als Auftrag übernommen oder Sprint gehört zu einem anderen Projekt.',
      });
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
    const sprintField = fields.find((field) => field.column === 'sprint_id');
    const update = buildUpdate('development_items', request.params.id, fields,
      `${DEV_COLUMNS}, project_slug AS "projectSlug"`);
    if (sprintField && !fields.some((field) => field.column === 'status')) {
      // Assigning a backlog order to a sprint plans it; removing it returns it to the backlog.
      update.sql = update.sql.replace(', updated_at = NOW()',
        `, status = CASE WHEN status IN ('backlog', 'planned') THEN $${update.values.length + 1} ELSE status END, updated_at = NOW()`);
      update.values.push(sprintField.value === null ? 'backlog' : 'planned');
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
  registerDocRoutes(app, pool);
  registerReportRoutes(app, pool);
  registerStatsRoutes(app, pool);
  registerWorkerRoutes(app, pool);

  app.get('*splat', (_request, response) => response.status(404).json({ message: 'Not found.' }));
  return app;
}
