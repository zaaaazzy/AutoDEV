import { encryptSecret, isEncrypted } from '../core/secrets.js';
import { SPRINT_MODES, type SprintMode } from './sprint-planning.js';
import { isValidWorkingHours, type WorkingHours } from '../core/working-hours.js';
import type { Router } from 'express';
import type { Pool } from 'pg';
import { ensureDefaultAgents, ensureVisualTester } from './agents.js';
import { parsePreviewSettings, VISUAL_COLUMNS } from './visual.js';
import { logged } from '../core/log.js';
import { targetsDevLogDatabase } from '../agent/tool-sql.js';
import { isValidGitRemote } from '../runner/git-sync.js';
import { healthUrlError, SERVICE_NAME } from '../runner/production-monitor.js';
import {
  isRecord,
  normalizeProjectSlug,
  PROJECT_SLUG,
  parseProjectSlug,
  projectFolderError,
  validText,
} from '../core/validation.js';
import { REVIEW_MODES } from '../core/status.js';

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

/** Einstellungen des Produktions-Rückkanals; vom Ingest-Token nur, ob eines hinterlegt ist. */
const PRODUCTION_COLUMNS = `health_url AS "healthUrl", log_services AS "logServices", production_ignore AS "productionIgnore", production_retention_days AS "productionRetentionDays", ingest_token_hash IS NOT NULL AS "ingestConfigured"`;

function lines(value: unknown, split: RegExp): string[] | null {
  if (typeof value === 'string')
    return value
      .split(split)
      .map((entry) => entry.trim())
      .filter(Boolean);
  if (Array.isArray(value) && value.every((entry) => typeof entry === 'string'))
    return value.map((entry: string) => entry.trim()).filter(Boolean);
  return null;
}

/** Prüft Health-URL, Log-Dienste, Ausschlussmuster und Aufbewahrung; liefert Spalten und Werte oder den Fehler. */
export function parseProductionSettings(body: Record<string, unknown>): [string, unknown][] | string {
  const sets: [string, unknown][] = [];
  if (body.healthUrl !== undefined) {
    const url = typeof body.healthUrl === 'string' ? body.healthUrl.trim() : body.healthUrl === null ? '' : null;
    if (url === null) return 'Ungültige Health-URL.';
    const error = url ? healthUrlError(url) : null;
    if (error) return error;
    sets.push(['health_url', url || null]);
  }
  if (body.logServices !== undefined) {
    const services = lines(body.logServices, /[\s,]+/);
    if (!services || services.length > 20 || services.some((service) => !SERVICE_NAME.test(service))) {
      return 'Log-Dienste: bis zu 20 Compose-Dienstnamen (Buchstaben, Ziffern, „-“, „_“, „.“), mit Komma getrennt.';
    }
    sets.push(['log_services', [...new Set(services)]]);
  }
  if (body.productionIgnore !== undefined) {
    const patterns = lines(body.productionIgnore, /\r?\n/);
    if (!patterns || patterns.length > 50 || patterns.some((pattern) => pattern.length > 200)) {
      return 'Ausschlussmuster: höchstens 50 Zeilen mit je bis zu 200 Zeichen.';
    }
    sets.push(['production_ignore', patterns]);
  }
  if (body.productionRetentionDays !== undefined) {
    const days = Number(body.productionRetentionDays);
    if (!Number.isInteger(days) || days < 1 || days > 365) return 'Aufbewahrung: 1 bis 365 Tage.';
    sets.push(['production_retention_days', days]);
  }
  return sets;
}

export function registerProjectRoutes(app: Router, pool: Pool): void {
  app.get('/projects', async (_request, response) => {
    // Mandantentrennung: nur freigeschaltete Projekte (null = Administrator, alle).
    const allowed = response.locals.allowedProjects as Set<string> | null | undefined;
    const result = await pool.query(
      `SELECT slug, name, repository, git_remote AS "gitRemote", database_url IS NOT NULL AS "databaseConfigured", test_commands AS "testCommands", deploy_commands AS "deployCommands", deploy_status AS "deployStatus", description, guidelines, auto_bugfix AS "autoBugfix", agent_workspace AS "agentWorkspace", review_mode AS "reviewMode", review_command AS "reviewCommand", review_url AS "reviewUrl", restart_after_sprint AS "restartAfterSprint", agent_permissions AS "agentPermissions", definition_of_ready AS "definitionOfReady", definition_of_done AS "definitionOfDone", sprint_mode AS "sprintMode", sprint_capacity_hours AS "sprintCapacityHours", autopilot_start AS "autopilotStart", autopilot_end AS "autopilotEnd", autopilot_days AS "autopilotDays", ${PRODUCTION_COLUMNS}, ${VISUAL_COLUMNS}, created_at AS "createdAt",
              EXTRACT(EPOCH FROM favicon_mtime)::bigint AS "faviconVersion"
         FROM projects
        WHERE $1::text[] IS NULL OR slug = ANY($1)
        ORDER BY name`,
      [allowed ? [...allowed] : null],
    );
    response.json({ projects: result.rows });
  });

  // Projekt löschen: Name zur Bestätigung; der Ordner auf dem Rechner wird auf Wunsch vom Worker gelöscht.
  app.delete('/projects/:slug', async (request, response, next) => {
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
  app.get('/projects/:slug/git-graph', async (request, response, next) => {
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
  app.get('/projects/:slug/favicon', async (request, response, next) => {
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

  app.patch('/projects/:slug', async (request, response) => {
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
        return fail('Der Zugang darf nicht auf die AIdeation-Datenbank zeigen.');
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
    if (body.reviewMode !== undefined) {
      if (typeof body.reviewMode !== 'string' || !REVIEW_MODES.has(body.reviewMode))
        return fail('Review-Freigabe: nie, nur bei Oberflächen-Änderungen oder immer.');
      values.push(body.reviewMode);
      sets.push(`review_mode = $${values.length}`);
    }
    if (body.reviewCommand !== undefined) {
      const line = typeof body.reviewCommand === 'string' ? body.reviewCommand.trim() : null;
      if (line === null || line.length > 500) return fail('Review-Befehl: ein Befehl, höchstens 500 Zeichen.');
      values.push(line ? JSON.stringify(line.split(/\s+/)) : null);
      sets.push(`review_command = $${values.length}::jsonb`);
    }
    if (body.reviewUrl !== undefined) {
      const url = typeof body.reviewUrl === 'string' ? body.reviewUrl.trim() : null;
      if (url === null || (url && !/^https?:\/\/\S{1,300}$/.test(url)))
        return fail('Review-Adresse: leer lassen oder eine http(s)-Adresse angeben.');
      values.push(url || null);
      sets.push(`review_url = $${values.length}`);
    }
    for (const key of ['description', 'guidelines'] as const) {
      if (body[key] === undefined) continue;
      if (typeof body[key] !== 'string' || body[key].length > 10_000) {
        return fail('Projektbeschreibung und Regeln dürfen höchstens 10000 Zeichen lang sein.');
      }
      values.push(body[key].trim());
      sets.push(`${key} = $${values.length}`);
    }
    if (body.sprintMode !== undefined) {
      if (!SPRINT_MODES.includes(body.sprintMode as SprintMode))
        return fail('Sprintplanung: manuell, vorschlagen oder Autopilot.');
      values.push(body.sprintMode);
      sets.push(`sprint_mode = $${values.length}`);
    }
    if (body.sprintCapacityHours !== undefined) {
      const hours = Number(body.sprintCapacityHours);
      if (!Number.isFinite(hours) || hours <= 0 || hours > 1000) return fail('Kapazität: Stunden zwischen 1 und 1000.');
      values.push(hours);
      sets.push(`sprint_capacity_hours = $${values.length}`);
    }
    if (body.autopilotStart !== undefined || body.autopilotEnd !== undefined || body.autopilotDays !== undefined) {
      // Immer als Ganzes: Start, Ende und Wochentage.
      const hours = { start: body.autopilotStart, end: body.autopilotEnd, days: body.autopilotDays };
      if (
        typeof hours.start !== 'string' ||
        typeof hours.end !== 'string' ||
        !Array.isArray(hours.days) ||
        !isValidWorkingHours(hours as WorkingHours)
      )
        return fail('Arbeitszeiten: Start und Ende als HH:MM und mindestens ein Wochentag.');
      values.push(hours.start, hours.end, hours.days);
      sets.push(
        `autopilot_start = $${values.length - 2}`,
        `autopilot_end = $${values.length - 1}`,
        `autopilot_days = $${values.length}::smallint[]`,
      );
    }
    const production = parseProductionSettings(body);
    if (typeof production === 'string') return fail(production);
    for (const [column, value] of production) {
      values.push(value);
      sets.push(`${column} = $${values.length}`);
    }
    const preview = parsePreviewSettings(body);
    if (typeof preview === 'string') return fail(preview);
    for (const [column, value] of preview) {
      values.push(value);
      sets.push(`${column} = $${values.length}${column === 'preview_url' ? '' : '::jsonb'}`);
    }
    if (body.autoBugfix !== undefined) {
      if (typeof body.autoBugfix !== 'boolean')
        return fail('Automatisches Bugfixing muss ein- oder ausgeschaltet sein.');
      values.push(body.autoBugfix);
      sets.push(`auto_bugfix = $${values.length}`);
    }
    if (body.agentWorkspace !== undefined) {
      if (typeof body.agentWorkspace !== 'boolean') return fail('Eigener Arbeitsordner: ein oder aus.');
      values.push(body.agentWorkspace);
      sets.push(`agent_workspace = $${values.length}`);
    }
    if (body.restartAfterSprint !== undefined) {
      if (typeof body.restartAfterSprint !== 'boolean') return fail('Neustart nach dem Sprint: ein oder aus.');
      values.push(body.restartAfterSprint);
      sets.push(`restart_after_sprint = $${values.length}`);
    }
    if (!sets.length) {
      return fail('Keine Änderung angegeben.');
    }
    const result = await pool.query(
      `UPDATE projects SET ${sets.join(', ')} WHERE slug = $1 RETURNING slug, name, repository, git_remote AS "gitRemote", database_url IS NOT NULL AS "databaseConfigured", test_commands AS "testCommands", deploy_commands AS "deployCommands", deploy_status AS "deployStatus", description, guidelines, auto_bugfix AS "autoBugfix", agent_workspace AS "agentWorkspace", review_mode AS "reviewMode", review_command AS "reviewCommand", review_url AS "reviewUrl", restart_after_sprint AS "restartAfterSprint", definition_of_ready AS "definitionOfReady", definition_of_done AS "definitionOfDone", sprint_mode AS "sprintMode", sprint_capacity_hours AS "sprintCapacityHours", autopilot_start AS "autopilotStart", autopilot_end AS "autopilotEnd", autopilot_days AS "autopilotDays", ${PRODUCTION_COLUMNS}, ${VISUAL_COLUMNS}`,
      values,
    );
    if (!result.rows[0]) {
      response.status(404).json({ message: 'Projekt nicht gefunden.' });
      return;
    }
    // Mit einer Vorschau-Adresse braucht der Workflow den visuellen Tester (einmalig nach dem Tester angelegt).
    if (preview.some(([column, value]) => column === 'preview_url' && value)) {
      await ensureVisualTester(pool, slug).catch(logged('projects'));
    }
    response.json({ project: result.rows[0] });
  });

  app.post('/projects', async (request, response) => {
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
