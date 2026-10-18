import type { Express } from 'express';
import type { Pool } from 'pg';
import { ensureDefaultAgents } from './agents.js';
import { targetsDevLogDatabase } from '../agent/tool-sql.js';
import { isValidGitRemote } from '../runner/git-sync.js';
import {
  isRecord,
  normalizeProjectSlug,
  PROJECT_SLUG,
  parseProjectSlug,
  projectFolderError,
  validText,
} from '../core/validation.js';

export function registerProjectRoutes(app: Express, pool: Pool): void {
  app.get('/api/projects', async (_request, response) => {
    const result = await pool.query(
      `SELECT slug, name, repository, git_remote AS "gitRemote", database_url IS NOT NULL AS "databaseConfigured", test_commands AS "testCommands", deploy_commands AS "deployCommands", deploy_status AS "deployStatus", description, guidelines, auto_bugfix AS "autoBugfix", agent_permissions AS "agentPermissions", definition_of_ready AS "definitionOfReady", definition_of_done AS "definitionOfDone", created_at AS "createdAt",
              EXTRACT(EPOCH FROM favicon_mtime)::bigint AS "faviconVersion"
         FROM projects
        ORDER BY name`,
    );
    response.json({ projects: result.rows });
  });

  // Projekt löschen: Name zur Bestätigung; der Ordner auf dem Rechner wird auf Wunsch vom Worker gelöscht.
  app.delete('/api/projects/:slug', async (request, response, next) => {
    try {
      const slug = parseProjectSlug(request.params.slug ?? '');
      const body = (isRecord(request.body) ? request.body : {}) as { confirm?: unknown; deleteFolder?: unknown };
      const project = slug
        ? (
            await pool.query<{ name: string; repository: string }>(
              'SELECT name, repository FROM projects WHERE slug = $1',
              [slug],
            )
          ).rows[0]
        : undefined;
      if (!project) return void response.status(404).json({ message: 'Projekt nicht gefunden.' });
      if (typeof body.confirm !== 'string' || body.confirm.trim() !== project.name) {
        return void response.status(400).json({ message: 'Bitte zur Bestätigung den Projektnamen genau eintippen.' });
      }
      const running = await pool.query(
        `SELECT 1 FROM agent_runs WHERE project_slug = $1 AND status = 'running'
          UNION ALL SELECT 1 FROM ideation_items WHERE project_slug = $1 AND status = 'drafting' LIMIT 1`,
        [slug],
      );
      if (running.rows[0]) {
        return void response
          .status(409)
          .json({ message: 'Gerade arbeitet ein Agent am Projekt – bitte warten oder abbrechen.' });
      }
      let folderJob: string | null = null;
      if (body.deleteFolder === true) {
        folderJob =
          (
            await pool.query<{ id: string }>(
              `INSERT INTO setup_jobs (kind, params) VALUES ('delete_folder', $1::jsonb) RETURNING id`,
              [JSON.stringify({ path: project.repository })],
            )
          ).rows[0]?.id ?? null;
      }
      await pool.query('DELETE FROM projects WHERE slug = $1', [slug]);
      response.json({ deleted: true, folderJob });
    } catch (error) {
      next(error);
    }
  });

  // Git-Verlauf (Commits, Branches) fürs Dashboard, vom Worker erfasst.
  app.get('/api/projects/:slug/git-graph', async (request, response, next) => {
    try {
      const slug = parseProjectSlug(request.params.slug ?? '');
      const row = slug
        ? (
            await pool.query<{ graph: unknown; updatedAt: Date }>(
              'SELECT graph, updated_at AS "updatedAt" FROM project_git_graphs WHERE project_slug = $1',
              [slug],
            )
          ).rows[0]
        : undefined;
      response.json({ graph: row?.graph ?? null, updatedAt: row?.updatedAt ?? null });
    } catch (error) {
      next(error);
    }
  });

  // Favicon der Anwendung; strenge CSP, damit ein SVG aus dem Projekt nie als Seite mit Skripten läuft.
  app.get('/api/projects/:slug/favicon', async (request, response, next) => {
    try {
      const slug = parseProjectSlug(request.params.slug ?? '');
      const row = slug
        ? (
            await pool.query<{ favicon: Buffer | null; type: string | null }>(
              'SELECT favicon, favicon_type AS type FROM projects WHERE slug = $1',
              [slug],
            )
          ).rows[0]
        : undefined;
      if (!row?.favicon || !row.type) {
        response.status(404).json({ message: 'Kein Favicon vorhanden.' });
        return;
      }
      response
        .set({
          'Content-Type': row.type,
          'Cache-Control': 'private, max-age=86400',
          'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
          'X-Content-Type-Options': 'nosniff',
        })
        .send(row.favicon);
    } catch (error) {
      next(error);
    }
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
        return fail(
          'Ungültige Repository-URL. Erlaubt: https://github.com/<user>/<repo>.git oder git@github.com:<user>/<repo>.git – ohne Zugangsdaten in der URL.',
        );
      }
      values.push(remote || null);
      sets.push(`git_remote = $${values.length}`);
    }
    if (body.databaseUrl !== undefined) {
      const url = typeof body.databaseUrl === 'string' ? body.databaseUrl.trim() : null;
      if (url === null || (url !== '' && (!/^postgres(?:ql)?:\/\/\S+$/.test(url) || url.length > 500))) {
        return fail('Ungültiger Datenbank-Zugang. Erlaubt: postgresql://user:passwort@host:port/datenbank');
      }
      if (url && targetsDevLogDatabase(url)) {
        return fail('Der Zugang darf nicht auf die Dev-Log-Datenbank zeigen.');
      }
      values.push(url || null);
      sets.push(`database_url = $${values.length}`);
    }
    if (body.repository !== undefined) {
      const folder = typeof body.repository === 'string' ? body.repository.trim() : '';
      const folderError = projectFolderError(folder);
      if (folderError) {
        return fail(folderError);
      }
      values.push(folder);
      sets.push(`repository = $${values.length}`);
    }
    for (const [field, column] of [
      ['definitionOfReady', 'definition_of_ready'],
      ['definitionOfDone', 'definition_of_done'],
    ] as const) {
      if (body[field] === undefined) continue;
      const raw = body[field];
      const items =
        typeof raw === 'string'
          ? raw
              .split('\n')
              .map((line) => line.replace(/^\s*[-*]\s*/, '').trim())
              .filter(Boolean)
          : Array.isArray(raw) && raw.every((entry) => typeof entry === 'string')
            ? (raw as string[]).map((entry) => entry.trim()).filter(Boolean)
            : null;
      if (!items || items.length > 20 || items.some((item) => item.length > 300)) {
        return fail('Definition of Ready/Done: höchstens 20 Punkte mit je bis zu 300 Zeichen, ein Punkt pro Zeile.');
      }
      values.push(items.length ? items : null);
      sets.push(`${column} = $${values.length}`);
    }
    if (body.testCommands !== undefined) {
      let commands: string[][] | null = null;
      if (typeof body.testCommands === 'string' && body.testCommands.trim()) {
        commands = body.testCommands
          .trim()
          .split('\n')
          .filter((line) => line.trim())
          .map((line) => line.trim().split(/\s+/));
      } else if (body.testCommands !== null && body.testCommands !== '') {
        return fail('Testbefehle: ein Befehl pro Zeile, z. B. „npm test“.');
      }
      values.push(commands ? JSON.stringify(commands) : null);
      sets.push(`test_commands = $${values.length}::jsonb`);
    }
    if (body.deployCommands !== undefined) {
      const lines =
        typeof body.deployCommands === 'string'
          ? body.deployCommands
              .split('\n')
              .map((line) => line.trim())
              .filter(Boolean)
          : null;
      if (!lines || lines.length > 10 || lines.some((line) => line.length > 500)) {
        return fail('Deploy-Befehle: höchstens 10 Zeilen, ein Befehl pro Zeile.');
      }
      values.push(lines.length ? JSON.stringify(lines.map((line) => line.split(/\s+/))) : null);
      sets.push(`deploy_commands = $${values.length}::jsonb`);
    }
    for (const key of ['description', 'guidelines'] as const) {
      if (body[key] === undefined) continue;
      if (typeof body[key] !== 'string' || body[key].length > 10_000) {
        return fail('Projektbeschreibung und Regeln dürfen höchstens 10000 Zeichen lang sein.');
      }
      values.push(body[key].trim());
      sets.push(`${key} = $${values.length}`);
    }
    if (body.autoBugfix !== undefined) {
      if (typeof body.autoBugfix !== 'boolean')
        return fail('Automatisches Bugfixing muss ein- oder ausgeschaltet sein.');
      values.push(body.autoBugfix);
      sets.push(`auto_bugfix = $${values.length}`);
    }
    if (!sets.length) {
      return fail('Keine Änderung angegeben.');
    }
    const result = await pool.query(
      `UPDATE projects SET ${sets.join(', ')} WHERE slug = $1 RETURNING slug, name, repository, git_remote AS "gitRemote", database_url IS NOT NULL AS "databaseConfigured", test_commands AS "testCommands", deploy_commands AS "deployCommands", deploy_status AS "deployStatus", description, guidelines, auto_bugfix AS "autoBugfix", definition_of_ready AS "definitionOfReady", definition_of_done AS "definitionOfDone"`,
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
    if (isRecord(body) && typeof body.slug === 'string') body.slug = normalizeProjectSlug(body.slug);
    const invalid = !isRecord(body)
      ? 'Ungültige Anfrage.'
      : !validText(body.name, 120)
        ? 'Bitte einen Projektnamen angeben (max. 120 Zeichen).'
        : typeof body.slug !== 'string' || !PROJECT_SLUG.test(body.slug)
          ? 'Die Projekt-ID darf nur Kleinbuchstaben, Ziffern und Bindestriche enthalten (z. B. „keyguard“).'
          : !validText(body.repository, 500)
            ? 'Bitte den Projektordner angeben.'
            : null;
    if (
      invalid ||
      !isRecord(body) ||
      typeof body.slug !== 'string' ||
      typeof body.name !== 'string' ||
      typeof body.repository !== 'string'
    ) {
      response.status(400).json({ message: invalid ?? 'Ungültige Anfrage.' });
      return;
    }
    const folderError = projectFolderError(body.repository);
    if (folderError) {
      response.status(400).json({ message: folderError });
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
}
