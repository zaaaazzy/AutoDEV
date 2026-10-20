import type { Router } from 'express';
import type { Pool } from 'pg';
import { ensureDefaultAgents } from './agents.js';
import { DEFAULT_PERMISSION_GROUPS, PERMISSION_GROUPS } from '../agent/tool-permissions.js';
import {
  isRecord,
  isUuid,
  normalizeProjectSlug,
  PROJECT_SLUG,
  projectFolderError,
  projectRoots,
  validText,
} from '../core/validation.js';
import { isValidGitRemote } from '../runner/git-sync.js';
import { SETUP_JOB_KINDS } from '../setup/setup-jobs.js';
import { TEMPLATE_GROUP_LABELS, TEMPLATES } from '../setup/templates.js';

const MAX_PARAMS_BYTES = 20_000;
const PROVIDERS = new Set(['ollama', 'claude', 'copilot', 'gemini']);

/** Agent-Befehl für alle Workflow-Agents eines neuen Projekts; null = lokales Modell (Ollama). */
export function agentCommand(provider: string, model: string): string[] | null {
  switch (provider) {
    case 'claude':
      return ['claude', '--model', model || 'sonnet', '--permission-mode', 'acceptEdits', '-p', '{prompt}'];
    case 'copilot':
      return ['copilot', '--allow-all-tools', '-p', '{prompt}'];
    case 'gemini':
      return ['gemini', '-m', model || 'gemini-2.5-pro', '-p', '{prompt}'];
    default:
      return null;
  }
}

function validGroups(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const known = new Set(PERMISSION_GROUPS.map((group) => group.id));
  return value.every((entry) => typeof entry === 'string' && known.has(entry)) ? [...new Set(value as string[])] : null;
}

/** Einrichtungsassistent: Vorlagen, Rechte-Gruppen, Host-Jobs (vom Worker ausgeführt) und Projekt anlegen. */
export function registerSetupRoutes(app: Router, pool: Pool): void {
  app.get('/setup/templates', (_request, response) => {
    response.json({
      groups: TEMPLATE_GROUP_LABELS,
      templates: TEMPLATES.map(({ id, label, description, group, stack }) => ({
        id,
        label,
        description,
        group,
        stack,
      })),
    });
  });

  // Projektbereich, damit der Assistent den Ordner vorschlagen und ausserhalb liegende Pfade erklären kann.
  app.get('/setup/scope', (_request, response) => {
    response.json({ roots: projectRoots() });
  });

  app.get('/setup/permissions', (_request, response) => {
    response.json({
      // „Dateien“ ist eine Agent-Gruppe (immer verfügbar) und gehört nicht zur Projektfreigabe.
      groups: PERMISSION_GROUPS.filter((group) => group.id !== 'files').map(({ id, label, description }) => ({
        id,
        label,
        description,
      })),
      defaults: DEFAULT_PERMISSION_GROUPS,
    });
  });

  app.post('/setup/jobs', async (request, response, next) => {
    try {
      const body = isRecord(request.body) ? request.body : {};
      const kind = typeof body.kind === 'string' ? body.kind : '';
      const params = isRecord(body.params) ? body.params : {};
      if (!(SETUP_JOB_KINDS as readonly string[]).includes(kind) || JSON.stringify(params).length > MAX_PARAMS_BYTES) {
        return void response.status(400).json({ message: 'Unbekannte oder zu große Einrichtungsaufgabe.' });
      }
      const job = (
        await pool.query<{ id: string }>(`INSERT INTO setup_jobs (kind, params) VALUES ($1, $2::jsonb) RETURNING id`, [
          kind,
          JSON.stringify(params),
        ])
      ).rows[0];
      response.status(202).json({ id: job?.id });
    } catch (error) {
      next(error);
    }
  });

  app.get('/setup/jobs/:id', async (request, response, next) => {
    try {
      if (!isUuid(request.params.id)) return void response.status(404).json({ message: 'Not found.' });
      const job = (
        await pool.query(`SELECT id, kind, status, result, log FROM setup_jobs WHERE id = $1`, [request.params.id])
      ).rows[0];
      if (!job) return void response.status(404).json({ message: 'Not found.' });
      response.set('Cache-Control', 'no-store').json({ job });
    } catch (error) {
      next(error);
    }
  });

  app.post('/projects/setup', async (request, response, next) => {
    try {
      const body = isRecord(request.body) ? request.body : {};
      const slug = normalizeProjectSlug(typeof body.slug === 'string' ? body.slug : '');
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      const repository = typeof body.repository === 'string' ? body.repository.trim() : '';
      const gitRemote = typeof body.gitRemote === 'string' && body.gitRemote.trim() ? body.gitRemote.trim() : null;
      const agent = isRecord(body.agent) ? body.agent : {};
      const provider = typeof agent.provider === 'string' ? agent.provider : 'ollama';
      const model = typeof agent.model === 'string' ? agent.model.slice(0, 80) : '';
      const groups = body.permissions === undefined ? DEFAULT_PERMISSION_GROUPS : validGroups(body.permissions);
      const invalid = !validText(name, 120)
        ? 'Bitte einen Projektnamen angeben.'
        : !PROJECT_SLUG.test(slug)
          ? 'Die Projekt-ID darf nur Kleinbuchstaben, Ziffern und Bindestriche enthalten.'
          : (projectFolderError(repository) ??
            (gitRemote && !isValidGitRemote(gitRemote)
              ? 'Ungültige GitHub-URL.'
              : !PROVIDERS.has(provider)
                ? 'Unbekannter Agent-Anbieter.'
                : !groups
                  ? 'Unbekannte Rechte-Gruppe.'
                  : null));
      if (invalid) return void response.status(400).json({ message: invalid });
      const exists = (await pool.query('SELECT 1 FROM projects WHERE slug = $1', [slug])).rowCount;
      if (exists) return void response.status(409).json({ message: `Die Projekt-ID „${slug}“ ist schon vergeben.` });
      const project = (
        await pool.query(
          `INSERT INTO projects (slug, name, repository, git_remote, agent_permissions)
           VALUES ($1, $2, $3, $4, $5) RETURNING slug, name, repository, git_remote AS "gitRemote"`,
          [slug, name, repository, gitRemote, groups],
        )
      ).rows[0];
      await ensureDefaultAgents(pool, slug);
      const command = agentCommand(provider, model);
      await pool.query('UPDATE agents SET command = $2, updated_at = NOW() WHERE project_slug = $1', [slug, command]);
      response.status(201).json({ project });
    } catch (error) {
      next(error);
    }
  });

  app.put('/projects/:slug/permissions', async (request, response, next) => {
    try {
      const slug =
        typeof request.params.slug === 'string' && PROJECT_SLUG.test(request.params.slug) ? request.params.slug : '';
      const groups = validGroups(isRecord(request.body) ? request.body.groups : null);
      if (!slug || !groups) return void response.status(400).json({ message: 'Ungültige Rechte.' });
      const result = await pool.query('UPDATE projects SET agent_permissions = $2 WHERE slug = $1', [slug, groups]);
      if (!result.rowCount) return void response.status(404).json({ message: 'Projekt nicht gefunden.' });
      response.json({ groups });
    } catch (error) {
      next(error);
    }
  });
}
