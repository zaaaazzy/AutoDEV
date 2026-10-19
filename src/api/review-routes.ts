import { logged } from '../core/log.js';
import type { Router } from 'express';
import type { Pool } from 'pg';
import { DEVELOPMENT_STATUS } from '../core/status.js';
import { isUuid, parseProjectSlug } from '../core/validation.js';
import { DEV_COLUMNS, retryComment } from './development.js';

const PORT_BASE = 4200;

export interface SlotView {
  slot: number;
  enabled: boolean;
  url: string;
  status: string;
  message: string | null;
  projectSlug: string | null;
  label: string | null;
  commit: string | null;
  developmentId: string | null;
  kind: string | null;
  startedAt: string | null;
}

/** Alle Review-Container; Inhalte fremder Projekte (Mandanten) bleiben verborgen. */
async function loadSlots(pool: Pool, allowed: Set<string> | null | undefined): Promise<SlotView[]> {
  const rows = (
    await pool.query<Omit<SlotView, 'url'>>(
      `SELECT slot, enabled, status, message, project_slug AS "projectSlug", label, commit_sha AS commit,
              development_id AS "developmentId", kind, started_at AS "startedAt"
         FROM review_slots ORDER BY slot`,
    )
  ).rows;
  return rows.map((row) => {
    const visible = !allowed || !row.projectSlug || allowed.has(row.projectSlug);
    return {
      ...row,
      url: `http://localhost:${PORT_BASE + row.slot}`,
      projectSlug: visible ? row.projectSlug : null,
      label: visible ? row.label : 'anderes Projekt',
      message: visible ? row.message : null,
      commit: visible ? row.commit : null,
      developmentId: visible ? row.developmentId : null,
    };
  });
}

/**
 * Container für einen Stand anfordern: derselbe Auftrag bzw. dasselbe Projekt, sonst ein freier, sonst der am
 * längsten laufende freigegebene Container (die Container sind geteilt). Liefert die Nummer oder null.
 */
async function requestSlot(
  pool: Pool,
  project: string,
  request: { commit: string | null; label: string; developmentId: string | null; kind: 'manual' | 'approval' },
): Promise<number | null> {
  const result = await pool.query<{ slot: number }>(
    `UPDATE review_slots SET status = 'requested', project_slug = $1, commit_sha = $2, label = $3, development_id = $4,
            kind = $5, message = 'Angefordert – startet gleich.', requested_at = NOW(), updated_at = NOW()
      WHERE slot = (
        SELECT slot FROM review_slots WHERE enabled
         ORDER BY (development_id IS NOT DISTINCT FROM $4::uuid AND $4::uuid IS NOT NULL) DESC,
                  (project_slug IS NOT DISTINCT FROM $1) DESC, (status = 'idle') DESC, requested_at NULLS FIRST, slot
         LIMIT 1)
      RETURNING slot`,
    [project, request.commit, request.label, request.developmentId, request.kind],
  );
  return result.rows[0]?.slot ?? null;
}

/**
 * Review-Freigabe und Review-Container: Ein fertiger Auftrag wartet (Status approval), bis ein Mensch ihn im Review-Container angesehen hat; in der Sprint-Ansicht lässt sich jeder Stand eines Sprints starten.
 * Freigeben merkt die Freigabe vor; gemergt wird vom Worker auf dem Host (dort liegt das Git-Repository).
 */
export function registerReviewRoutes(app: Router, pool: Pool): void {
  app.get('/projects/:slug/review', async (request, response) => {
    const slug = parseProjectSlug(request.params.slug);
    if (!slug) {
      response.status(404).json({ message: 'Projekt nicht gefunden.' });
      return;
    }
    const project = await pool.query<{ mode: string; configured: boolean }>(
      `SELECT review_mode AS mode, review_command IS NOT NULL AS configured FROM projects WHERE slug = $1`,
      [slug],
    );
    if (!project.rows[0]) {
      response.status(404).json({ message: 'Projekt nicht gefunden.' });
      return;
    }
    const waiting = await pool.query(
      `SELECT id, title, review_since AS "reviewSince", review_approved_at AS "reviewApprovedAt"
         FROM development_items WHERE project_slug = $1 AND status = '${DEVELOPMENT_STATUS.approval}'
        ORDER BY review_since NULLS LAST`,
      [slug],
    );
    response.json({
      mode: project.rows[0].mode,
      configured: project.rows[0].configured,
      slots: await loadSlots(pool, response.locals.allowedProjects as Set<string> | null | undefined),
      waiting: waiting.rows,
    });
  });

  app.get('/review-slots', async (_request, response) => {
    response.json({ slots: await loadSlots(pool, response.locals.allowedProjects as Set<string> | null | undefined) });
  });

  // Administrator: Review-Container freigeben bzw. sperren (ein gesperrter wird vom Worker beendet).
  app.put('/review-slots/:slot', async (request, response) => {
    const slot = Number(request.params.slot);
    const enabled = (request.body as { enabled?: unknown } | undefined)?.enabled;
    if (!Number.isInteger(slot) || slot < 1 || slot > 9 || typeof enabled !== 'boolean') {
      response.status(400).json({ message: 'Ungültiger Review-Container.' });
      return;
    }
    await pool.query(
      `INSERT INTO review_slots (slot, enabled) VALUES ($1, $2)
       ON CONFLICT (slot) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = NOW()`,
      [slot, enabled],
    );
    response.json({ slots: await loadSlots(pool, null) });
  });

  app.post('/review-slots/:slot/stop', async (request, response) => {
    const slot = Number(request.params.slot);
    const allowed = response.locals.allowedProjects as Set<string> | null | undefined;
    const result = await pool.query(
      `UPDATE review_slots SET status = 'stopping', updated_at = NOW()
        WHERE slot = $1 AND status <> 'idle' AND ($2::text[] IS NULL OR project_slug = ANY($2))`,
      [Number.isInteger(slot) ? slot : 0, allowed ? [...allowed] : null],
    );
    if (!result.rowCount) {
      response.status(409).json({ message: 'Dieser Review-Container läuft nicht.' });
      return;
    }
    response.json({ ok: true });
  });

  // Sprint-Ansicht: einen Stand (Commit) des Projekts in einem Review-Container starten.
  app.post('/projects/:slug/review-slots/start', async (request, response) => {
    const slug = parseProjectSlug(request.params.slug);
    const body = (request.body ?? {}) as { commit?: unknown; label?: unknown; developmentId?: unknown };
    const commit = typeof body.commit === 'string' && /^[0-9a-f]{40}$/.test(body.commit) ? body.commit : null;
    if (!slug || !commit) {
      response.status(400).json({ message: 'Bitte einen Stand (Commit) wählen.' });
      return;
    }
    const label = typeof body.label === 'string' ? body.label.trim().slice(0, 200) : '';
    const developmentId =
      typeof body.developmentId === 'string' && isUuid(body.developmentId) ? body.developmentId : null;
    const slot = await requestSlot(pool, slug, {
      commit,
      label: label || commit.slice(0, 8),
      developmentId,
      kind: 'manual',
    });
    if (!slot) {
      response.status(409).json({
        message: 'Kein Review-Container freigegeben – ein Administrator kann ihn unter Einstellungen freigeben.',
      });
      return;
    }
    response.json({ slot });
  });

  app.get('/sprints/:id/commits', async (request, response) => {
    if (!isUuid(request.params.id)) {
      response.status(404).json({ message: 'Sprint nicht gefunden.' });
      return;
    }
    const row = (
      await pool.query(`SELECT branch, commits, updated_at AS "updatedAt" FROM sprint_commits WHERE sprint_id = $1`, [
        request.params.id,
      ])
    ).rows[0];
    response.json(row ?? { branch: null, commits: [], updatedAt: null });
  });

  app.post('/development/:id/approve', async (request, response) => {
    if (!isUuid(request.params.id)) {
      response.status(404).json({ message: 'Auftrag nicht gefunden.' });
      return;
    }
    const result = await pool.query(
      `UPDATE development_items SET review_approved_at = COALESCE(review_approved_at, NOW()), updated_at = NOW()
        WHERE id = $1 AND status = '${DEVELOPMENT_STATUS.approval}' RETURNING ${DEV_COLUMNS}, project_slug AS "projectSlug"`,
      [request.params.id],
    );
    const item = result.rows[0] as { projectSlug: string } | undefined;
    if (!item) {
      response.status(409).json({ message: 'Nur Aufträge, die auf die Freigabe warten, können freigegeben werden.' });
      return;
    }
    // Worker sofort wecken: er mergt zwischen zwei Aufträgen.
    await pool.query(`SELECT pg_notify('devlog_work', $1)`, [item.projectSlug]).catch(logged('review-routes'));
    response.json({ item });
  });

  app.post('/development/:id/review-reject', async (request, response) => {
    if (!isUuid(request.params.id)) {
      response.status(404).json({ message: 'Auftrag nicht gefunden.' });
      return;
    }
    const comment = retryComment(request.body);
    if (!comment) {
      response.status(400).json({ message: 'Bitte kurz beschreiben, was nicht passt – das geht an den Entwickler.' });
      return;
    }
    // Zurück an die Agents: der Auftrag läuft erneut auf seinem Branch, die Rückmeldung steht in der Beschreibung.
    const result = await pool.query(
      `UPDATE development_items d SET status = '${DEVELOPMENT_STATUS.planned}', auto_run = TRUE, review_approved_at = NULL,
              review_since = NULL, failure = NULL, action_todo = NULL, budget_since = NOW(), updated_at = NOW(),
              description = COALESCE(d.description, '') || E'\\n\\n## Rückmeldung aus der Review-Freigabe (' ||
                to_char(NOW(), 'DD.MM.YYYY HH24:MI') || E')\\n' || $2::text
        WHERE d.id = $1 AND d.status = '${DEVELOPMENT_STATUS.approval}' AND d.review_approved_at IS NULL
        RETURNING ${DEV_COLUMNS}`,
      [request.params.id, comment],
    );
    if (!result.rows[0]) {
      response
        .status(409)
        .json({ message: 'Nur Aufträge, die noch auf die Freigabe warten, können zurückgewiesen werden.' });
      return;
    }
    response.json({ item: result.rows[0] });
  });

  app.post('/development/:id/show-review', async (request, response) => {
    if (!isUuid(request.params.id)) {
      response.status(404).json({ message: 'Auftrag nicht gefunden.' });
      return;
    }
    const item = await pool.query<{ slug: string }>(
      `SELECT project_slug AS slug FROM development_items WHERE id = $1 AND status = '${DEVELOPMENT_STATUS.approval}'`,
      [request.params.id],
    );
    const slug = item.rows[0]?.slug;
    if (!slug) {
      response.status(409).json({ message: 'Der Auftrag wartet nicht auf eine Freigabe.' });
      return;
    }
    const title = (
      await pool.query<{ title: string }>('SELECT title FROM development_items WHERE id = $1', [request.params.id])
    ).rows[0]?.title;
    const slot = await requestSlot(pool, slug, {
      commit: null,
      label: `Freigabe: ${title ?? ''}`.slice(0, 200),
      developmentId: request.params.id,
      kind: 'approval',
    });
    if (!slot) {
      response.status(409).json({
        message: 'Kein Review-Container freigegeben – ein Administrator kann ihn unter Einstellungen freigeben.',
      });
      return;
    }
    response.json({ ok: true });
  });
}
