import { encryptSecret, isEncrypted } from '../core/secrets.js';
import type { Express } from 'express';
import type { Pool } from 'pg';
import { ensureDefaultAgents } from './agents.js';
import { targetsDevLogDatabase } from '../agent/tool-sql.js';
import { isValidGitRemote } from '../runner/git-sync.js';
import { isRecord, PROJECT_SLUG, parseProjectSlug, projectFolderError, validText } from '../core/validation.js';

/** With DEV_LOG_SECRET_KEY set, database access stored before encryption existed is encrypted once at start. */
export async function encryptProjectSecrets(pool: Pool): Promise<number> {
  if (!process.env.DEV_LOG_SECRET_KEY?.trim()) return 0;
  const rows = (
    await pool.query<{ slug: string; url: string }>(
      'SELECT slug, database_url AS url FROM projects WHERE database_url IS NOT NULL',
    )
  ).rows.filter((row) => !isEncrypted(row.url));
  for (const row of rows) {
    await pool.query('UPDATE projects SET database_url = $2 WHERE slug = $1 AND database_url = $3', [
      row.slug,
      encryptSecret(row.url),
      row.url,
    ]);
  }
  return rows.length;
}

export function registerProjectRoutes(app: Express, pool: Pool): void {
  app.get('/api/projects', async (_request, response) => {
    const result = await pool.query(
      `SELECT slug, name, repository, git_remote AS "gitRemote", database_url IS NOT NULL AS "databaseConfigured", test_commands AS "testCommands", deploy_commands AS "deployCommands", deploy_status AS "deployStatus", description, guidelines, auto_bugfix AS "autoBugfix", isolated_runs AS "isolatedRuns", created_at AS "createdAt"
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
    if (body.databaseUrl !== undefined) {
      const url = typeof body.databaseUrl === 'string' ? body.databaseUrl.trim() : null;
      if (url === null || (url !== '' && (!/^postgres(?:ql)?:\/\/\S+$/.test(url) || url.length > 500))) {
        return fail('Ungültiger Datenbank-Zugang. Erlaubt: postgresql://user:passwort@host:port/datenbank');
      }
      if (url && targetsDevLogDatabase(url)) {
        return fail('Der Zugang darf nicht auf die Dev-Log-Datenbank zeigen.');
      }
      values.push(url ? encryptSecret(url) : null);
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
    if (body.isolatedRuns !== undefined) {
      if (typeof body.isolatedRuns !== 'boolean') return fail('Isolierte Läufe müssen ein- oder ausgeschaltet sein.');
      values.push(body.isolatedRuns);
      sets.push(`isolated_runs = $${values.length}`);
    }
    if (!sets.length) {
      return fail('Keine Änderung angegeben.');
    }
    const result = await pool.query(
      `UPDATE projects SET ${sets.join(', ')} WHERE slug = $1 RETURNING slug, name, repository, git_remote AS "gitRemote", database_url IS NOT NULL AS "databaseConfigured", test_commands AS "testCommands", deploy_commands AS "deployCommands", deploy_status AS "deployStatus", description, guidelines, auto_bugfix AS "autoBugfix", isolated_runs AS "isolatedRuns"`,
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
