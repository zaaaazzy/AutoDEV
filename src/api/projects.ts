import type { RequestHandler, Router } from 'express';
import type { Pool } from 'pg';
import { logged } from '../core/log.js';
import {
  isRecord,
  normalizeProjectSlug,
  PROJECT_SLUG,
  parseProjectSlug,
  projectFolderError,
  validText,
} from '../core/validation.js';
import {
  agentWorking,
  createProject,
  deleteProject,
  findFavicon,
  findGitGraph,
  findProjectGitRemote,
  findProjectIdentity,
  listProjects,
  resetGithubAuthCheck,
  updateProject,
} from '../db/project-repository.js';
import { githubRepo } from '../runner/github.js';
import { access } from './access.js';
import { ensureDefaultAgents, ensureVisualTester } from './agents.js';
import { parseProjectPatch } from './project-input.js';

const PROJECT_NOT_FOUND = { message: 'Projekt nicht gefunden.' };
/** Routen mit Projekt-ID im Pfad. */
type SlugHandler = RequestHandler<{ slug: string }>;

/** „Anmeldung prüfen“: Der Worker fragt `gh auth status` beim nächsten Takt erneut ab (nur bei aktivem Modus). */
const checkGithubAuth =
  (pool: Pool): SlugHandler =>
  async (request, response) => {
    const slug = parseProjectSlug(request.params.slug ?? '');
    const github = slug ? await resetGithubAuthCheck(pool, slug) : undefined;
    if (!github) return void response.status(404).json(PROJECT_NOT_FOUND);
    response.json({ github });
  };

/** Mandantentrennung: nur freigeschaltete Projekte (null = Administrator, alle). */
const list =
  (pool: Pool): RequestHandler =>
  async (_request, response) => {
    const allowed = response.locals.allowedProjects as Set<string> | null | undefined;
    response.json({ projects: await listProjects(pool, allowed ?? null) });
  };

/** Projekt löschen: Name zur Bestätigung; der Ordner auf dem Rechner wird auf Wunsch vom Worker gelöscht. */
const remove =
  (pool: Pool): SlugHandler =>
  async (request, response) => {
    const slug = parseProjectSlug(request.params.slug ?? '');
    const body = (isRecord(request.body) ? request.body : {}) as { confirm?: unknown; deleteFolder?: unknown };
    const project = slug ? await findProjectIdentity(pool, slug) : undefined;
    if (!slug || !project) return void response.status(404).json(PROJECT_NOT_FOUND);
    if (typeof body.confirm !== 'string' || body.confirm.trim() !== project.name) {
      return void response.status(400).json({ message: 'Bitte zur Bestätigung den Projektnamen genau eintippen.' });
    }
    if (await agentWorking(pool, slug)) {
      return void response
        .status(409)
        .json({ message: 'Gerade arbeitet ein Agent am Projekt – bitte warten oder abbrechen.' });
    }
    const folderJob = await deleteProject(pool, slug, body.deleteFolder === true ? project.repository : null);
    response.json({ deleted: true, folderJob });
  };

/** Git-Verlauf (Commits, Branches) fürs Dashboard, vom Worker erfasst. */
const gitGraph =
  (pool: Pool): SlugHandler =>
  async (request, response) => {
    const slug = parseProjectSlug(request.params.slug ?? '');
    const row = slug ? await findGitGraph(pool, slug) : undefined;
    response.json({ graph: row?.graph ?? null, updatedAt: row?.updatedAt ?? null });
  };

/** Favicon der Anwendung; strenge CSP, damit ein SVG aus dem Projekt nie als Seite mit Skripten läuft. */
const favicon =
  (pool: Pool): SlugHandler =>
  async (request, response) => {
    const slug = parseProjectSlug(request.params.slug ?? '');
    const row = slug ? await findFavicon(pool, slug) : undefined;
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
  };

/** Die GitHub-Brücke braucht ein GitHub-Repository: aus dem Body (gitRemote) oder aus dem gespeicherten Projekt. */
async function githubRemoteMissing(pool: Pool, slug: string, body: Record<string, unknown>): Promise<boolean> {
  const remote = typeof body.gitRemote === 'string' ? body.gitRemote.trim() : await findProjectGitRemote(pool, slug);
  return !githubRepo(remote);
}

/** Einstellungen ändern: Prüfung je Feldgruppe in project-input.ts, dann eine UPDATE-Anweisung. */
const patch =
  (pool: Pool): SlugHandler =>
  async (request, response) => {
    const slug = parseProjectSlug(request.params.slug ?? '');
    if (!slug) return void response.status(400).json({ message: 'Ungültiges Projekt.' });
    const body: Record<string, unknown> = isRecord(request.body) ? request.body : {};
    const parsed = parseProjectPatch(body);
    if (typeof parsed === 'string') return void response.status(400).json({ message: parsed });
    if (parsed.githubMode && parsed.githubMode !== 'aus' && (await githubRemoteMissing(pool, slug, body))) {
      return void response
        .status(400)
        .json({ message: 'Die GitHub-Brücke braucht ein GitHub-Repository (github.com) am Projekt.' });
    }
    const project = await updateProject(pool, slug, parsed.assignments);
    if (!project) return void response.status(404).json(PROJECT_NOT_FOUND);
    // Mit einer Vorschau-Adresse braucht der Workflow den visuellen Tester (einmalig nach dem Tester angelegt).
    if (parsed.setsPreviewUrl) await ensureVisualTester(pool, slug).catch(logged('projects'));
    response.json({ project });
  };

/** Fehlertext für einen neuen Projektkörper oder null, wenn er vollständig ist. */
function newProjectError(body: unknown): string | null {
  if (!isRecord(body)) return 'Ungültige Anfrage.';
  if (!validText(body.name, 120)) return 'Bitte einen Projektnamen angeben (max. 120 Zeichen).';
  if (typeof body.slug !== 'string' || !PROJECT_SLUG.test(body.slug)) {
    return 'Die Projekt-ID darf nur Kleinbuchstaben, Ziffern und Bindestriche enthalten (z. B. „keyguard“).';
  }
  if (!validText(body.repository, 500)) return 'Bitte den Projektordner angeben.';
  return typeof body.repository === 'string' ? projectFolderError(body.repository) : 'Ungültige Anfrage.';
}

const create =
  (pool: Pool): RequestHandler =>
  async (request, response) => {
    const body = request.body as unknown;
    if (isRecord(body) && typeof body.slug === 'string') body.slug = normalizeProjectSlug(body.slug);
    const invalid = newProjectError(body);
    if (
      invalid ||
      !isRecord(body) ||
      typeof body.slug !== 'string' ||
      typeof body.name !== 'string' ||
      typeof body.repository !== 'string'
    ) {
      return void response.status(400).json({ message: invalid ?? 'Ungültige Anfrage.' });
    }
    const project = await createProject(pool, body.slug, body.name.trim(), body.repository.trim());
    // Vergebene ID: nie Name und Ordner eines bestehenden Projekts überschreiben (wie in der Einrichtung).
    if (!project) {
      return void response.status(409).json({ message: `Die Projekt-ID „${body.slug}“ ist schon vergeben.` });
    }
    await ensureDefaultAgents(pool, body.slug);
    response.status(201).json({ project });
  };

export function registerProjectRoutes(app: Router, pool: Pool): void {
  const admin = { role: 'admin', tenant: 'project' } as const;
  app.post('/projects/:slug/github/check', access(admin), checkGithubAuth(pool));
  app.get('/projects', access({ tenant: 'global' }), list(pool));
  app.delete('/projects/:slug', access(admin), remove(pool));
  app.get('/projects/:slug/git-graph', access({ tenant: 'project' }), gitGraph(pool));
  app.get('/projects/:slug/favicon', access({ tenant: 'project' }), favicon(pool));
  app.patch('/projects/:slug', access(admin), patch(pool));
  app.post('/projects', access({ role: 'admin', tenant: 'admin' }), create(pool));
}
