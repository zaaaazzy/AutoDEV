import type { Express } from 'express';
import type { Pool } from 'pg';
import { ensureDefaultAgents } from './agents.js';
import { isValidGitRemote } from '../runner/git-sync.js';
import { isRecord, PROJECT_SLUG, parseProjectSlug, projectFolderError, validText } from '../core/validation.js';

export function registerProjectRoutes(app: Express, pool: Pool): void {
  app.get('/api/projects', async (_request, response) => {
    const result = await pool.query(
      `SELECT slug, name, repository, git_remote AS "gitRemote", test_commands AS "testCommands", description, guidelines, auto_bugfix AS "autoBugfix", created_at AS "createdAt"
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
        return fail(
          'Ungültige Repository-URL. Erlaubt: https://github.com/<user>/<repo>.git oder git@github.com:<user>/<repo>.git – ohne Zugangsdaten in der URL.',
        );
      }
      values.push(remote || null);
      sets.push(`git_remote = $${values.length}`);
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
      `UPDATE projects SET ${sets.join(', ')} WHERE slug = $1 RETURNING slug, name, repository, git_remote AS "gitRemote", test_commands AS "testCommands", description, guidelines, auto_bugfix AS "autoBugfix"`,
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
    if (
      !isRecord(body) ||
      typeof body.slug !== 'string' ||
      !PROJECT_SLUG.test(body.slug) ||
      !validText(body.name, 120) ||
      !validText(body.repository, 500)
    ) {
      response.status(400).json({ message: 'Project slug, name, and repository are required.' });
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
