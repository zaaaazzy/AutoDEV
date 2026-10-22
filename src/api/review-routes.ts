import { logged } from '../core/log.js';
import type { Router } from 'express';
import type { Pool } from 'pg';
import { DEVELOPMENT_STATUS } from '../core/status.js';
import { isUuid, parseProjectSlug } from '../core/validation.js';
import { access } from './access.js';
import { DEV_COLUMNS, retryComment } from './development.js';
import { guardGit } from './git-state.js';

const PORT_BASE = 4200;
/** Sprints, deren Stände die Kopfzeile anbietet (laufender Sprint zuerst). */
const REVIEW_COMMIT_SPRINTS = 3;

/** Stand, wie ihn der Worker in sprint_commits ablegt (src/runner/sprint-commits.ts). */
interface StoredCommit {
  hash: string;
  subject: string;
  date: string;
  developmentId: string | null;
  merged: boolean;
}

/** Startbarer Stand für die Kopfzeile: mit Auftragsname und Sprint. */
export interface ReviewCommit extends StoredCommit {
  /** Titel des Auftrags; ohne Auftrag (z. B. Sprint-Sicherung) der bereinigte Commit-Betreff. */
  title: string;
  orderStatus: string | null;
  sprintId: string;
  sprintName: string;
  sprintStatus: string;
}

/** Betreff ohne Merge-Präfix und ohne den Hinweis des Workers „(noch nicht im Sprint)“. */
export function commitTitle(subject: string): string {
  return subject
    .replace(/^Merge (?:branch )?'?auftrag\/[^\s:']+'?(?: into [^\s:]+)?:?\s*/i, '')
    .replace(/\s*\(noch nicht im Sprint\)$/, '')
    .trim();
}

/** Stände je Sprint in Auswahl-Reihenfolge, jeder Commit nur einmal (der erste Sprint gewinnt). */
export function reviewCommits(
  sprints: { id: string; name: string; status: string; commits: StoredCommit[] }[],
  orders: Map<string, { title: string; status: string }>,
): ReviewCommit[] {
  const seen = new Set<string>();
  const result: ReviewCommit[] = [];
  for (const sprint of sprints) {
    for (const commit of sprint.commits) {
      if (!commit?.hash || seen.has(commit.hash)) continue;
      seen.add(commit.hash);
      const order = commit.developmentId ? orders.get(commit.developmentId) : undefined;
      result.push({
        ...commit,
        title: order?.title ?? (commitTitle(commit.subject) || commit.hash.slice(0, 7)),
        orderStatus: order?.status ?? null,
        sprintId: sprint.id,
        sprintName: sprint.name,
        sprintStatus: sprint.status,
      });
    }
  }
  return result;
}

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

/** Gewählte Umgebung aus dem Body: null = keine Wahl (requestSlot sucht selbst), undefined = ungültig. */
export function chosenSlot(body: unknown): number | null | undefined {
  const value = (body as { slot?: unknown } | null | undefined)?.slot;
  if (value === undefined || value === null) return null;
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 9 ? (value as number) : undefined;
}

/** Antwort, wenn kein (bzw. der gewählte) Container nicht freigegeben ist. */
function noSlotMessage(wanted: number | null): string {
  return wanted !== null
    ? `Umgebung ${wanted} ist nicht freigegeben – ein Administrator kann sie unter Einstellungen freigeben.`
    : 'Kein Review-Container freigegeben – ein Administrator kann ihn unter Einstellungen freigeben.';
}

/**
 * Container für einen Stand anfordern: derselbe Auftrag, sonst bei einem manuellen Start der manuelle Container
 * desselben Projekts (ein neuer Stand ersetzt den eigenen), sonst ein freier, sonst der am längsten laufende
 * freigegebene Container – dabei zuletzt eine laufende Freigabe (die Container sind geteilt). Ein manueller Start
 * verdrängt so keine Freigabe-Vorschau, solange ein Container frei ist. Mit `slot` genau dieser (gewählt in der
 * optischen Abnahme), sofern er freigegeben ist. Liefert die Nummer oder null.
 */
async function requestSlot(
  pool: Pool,
  project: string,
  request: {
    commit: string | null;
    label: string;
    developmentId: string | null;
    kind: 'manual' | 'approval';
    slot?: number | null;
  },
): Promise<number | null> {
  const result = await pool.query<{ slot: number }>(
    `UPDATE review_slots SET status = 'requested', project_slug = $1, commit_sha = $2, label = $3, development_id = $4,
            kind = $5, message = 'Angefordert – startet gleich.', requested_at = NOW(), updated_at = NOW()
      WHERE slot = (
        SELECT slot FROM review_slots WHERE enabled AND ($6::int IS NULL OR slot = $6)
         ORDER BY (development_id IS NOT DISTINCT FROM $4::uuid AND $4::uuid IS NOT NULL) DESC,
                  (project_slug IS NOT DISTINCT FROM $1 AND kind = 'manual' AND $5::text = 'manual') DESC,
                  (status = 'idle') DESC,
                  (status <> 'idle' AND kind = 'approval') ASC, requested_at NULLS FIRST, slot
         LIMIT 1)
      RETURNING slot`,
    [project, request.commit, request.label, request.developmentId, request.kind, request.slot ?? null],
  );
  return result.rows[0]?.slot ?? null;
}

/**
 * Review-Freigabe und Review-Container: Ein fertiger Auftrag wartet (Status approval), bis ein Mensch ihn im Review-Container angesehen hat; in der Sprint-Ansicht lässt sich jeder Stand eines Sprints starten.
 * Freigeben merkt die Freigabe vor; gemergt wird vom Worker auf dem Host (dort liegt das Git-Repository).
 */
export function registerReviewRoutes(app: Router, pool: Pool): void {
  app.get('/projects/:slug/review', access({ tenant: 'project' }), async (request, response) => {
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

  // Review-Container sind projektübergreifend; Inhalte fremder Projekte blendet loadSlots aus.
  app.get('/review-slots', access({ tenant: 'global' }), async (_request, response) => {
    response.json({ slots: await loadSlots(pool, response.locals.allowedProjects as Set<string> | null | undefined) });
  });

  // Administrator: Review-Container freigeben bzw. sperren (ein gesperrter wird vom Worker beendet).
  app.put('/review-slots/:slot', access({ role: 'admin', tenant: 'admin' }), async (request, response) => {
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

  // Beenden ist Ausführen; die Abfrage trifft nur Container der eigenen Projekte (allowedProjects).
  app.post('/review-slots/:slot/stop', access({ role: 'run', tenant: 'global' }), async (request, response) => {
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
  app.post(
    '/projects/:slug/review-slots/start',
    access({ role: 'run', tenant: 'project' }),
    async (request, response) => {
      const slug = parseProjectSlug(request.params.slug);
      const body = (request.body ?? {}) as {
        commit?: unknown;
        label?: unknown;
        developmentId?: unknown;
        slot?: unknown;
      };
      const commit = typeof body.commit === 'string' && /^[0-9a-f]{40}$/.test(body.commit) ? body.commit : null;
      if (!slug || !commit) {
        response.status(400).json({ message: 'Bitte einen Stand (Commit) wählen.' });
        return;
      }
      const label = typeof body.label === 'string' ? body.label.trim().slice(0, 200) : '';
      const developmentId =
        typeof body.developmentId === 'string' && isUuid(body.developmentId) ? body.developmentId : null;
      // Der Mandant ist über :slug geprüft, der Auftrag nicht: Ein Auftrag aus einem anderen Projekt übernähme sonst
      // dessen Container (requestSlot bevorzugt den Container desselben Auftrags).
      if (
        developmentId &&
        !(
          await pool.query('SELECT 1 FROM development_items WHERE id = $1 AND project_slug = $2', [developmentId, slug])
        ).rowCount
      ) {
        response.status(404).json({ message: 'Auftrag nicht gefunden.' });
        return;
      }
      // Gewählte Umgebung; ohne Angabe sucht requestSlot einen passenden Container.
      const wanted = chosenSlot(body);
      if (wanted === undefined) {
        response.status(400).json({ message: 'Ungültige Umgebung.' });
        return;
      }
      const slot = await requestSlot(pool, slug, {
        commit,
        label: label || commit.slice(0, 8),
        developmentId,
        kind: 'manual',
        slot: wanted,
      });
      if (!slot) {
        response.status(409).json({ message: noSlotMessage(wanted) });
        return;
      }
      response.json({ slot });
    },
  );

  app.get('/sprints/:id/commits', access({ tenant: 'sprints' }), async (request, response) => {
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

  // Kopfzeile: startbare Stände des Projekts mit Auftrag und Sprint – laufender Sprint zuerst, dann die letzten.
  app.get('/projects/:slug/review-commits', access({ tenant: 'project' }), async (request, response) => {
    const slug = parseProjectSlug(request.params.slug);
    if (!slug) {
      response.status(404).json({ message: 'Projekt nicht gefunden.' });
      return;
    }
    const sprints = (
      await pool.query<{ id: string; name: string; status: string; commits: StoredCommit[] }>(
        `SELECT s.id, s.name, s.status, c.commits FROM sprints s JOIN sprint_commits c ON c.sprint_id = s.id
          WHERE s.project_slug = $1 AND s.status <> 'planned' AND jsonb_array_length(c.commits) > 0
          ORDER BY (s.status IN ('active', 'review')) DESC, s.created_at DESC
          LIMIT ${REVIEW_COMMIT_SPRINTS}`,
        [slug],
      )
    ).rows;
    const ids = [...new Set(sprints.flatMap((sprint) => sprint.commits.map((commit) => commit.developmentId)))].filter(
      (id): id is string => typeof id === 'string' && isUuid(id),
    );
    const titles = new Map(
      ids.length
        ? (
            await pool.query<{ id: string; title: string; status: string }>(
              `SELECT id, title, status FROM development_items WHERE project_slug = $1 AND id = ANY($2::uuid[])`,
              [slug, ids],
            )
          ).rows.map((row) => [row.id, row])
        : [],
    );
    response.json({ commits: reviewCommits(sprints, titles) });
  });

  app.post('/development/:id/approve', access({ role: 'run', tenant: 'development' }), async (request, response) => {
    if (!isUuid(request.params.id)) {
      response.status(404).json({ message: 'Auftrag nicht gefunden.' });
      return;
    }
    // Der Worker mergt im Ordner der Agents: dort dürfen keine fremden Änderungen oder Branches liegen.
    const owner = (
      await pool.query<{ slug: string }>('SELECT project_slug AS slug FROM development_items WHERE id = $1', [
        request.params.id,
      ])
    ).rows[0];
    if (owner && !(await guardGit(pool, owner.slug, 'approve', request.body, response))) return;
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

  app.post(
    '/development/:id/review-reject',
    access({ role: 'run', tenant: 'development' }),
    async (request, response) => {
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
    },
  );

  app.post(
    '/development/:id/show-review',
    access({ role: 'run', tenant: 'development' }),
    async (request, response) => {
      if (!isUuid(request.params.id)) {
        response.status(404).json({ message: 'Auftrag nicht gefunden.' });
        return;
      }
      // Optische Abnahme: in der gewählten Umgebung starten.
      const wanted = chosenSlot(request.body);
      if (wanted === undefined) {
        response.status(400).json({ message: 'Ungültige Umgebung.' });
        return;
      }
      const item = (
        await pool.query<{ slug: string; title: string; status: string }>(
          'SELECT project_slug AS slug, title, status FROM development_items WHERE id = $1',
          [request.params.id],
        )
      ).rows[0];
      // Freigabe: Stand des Auftrags-Branches. Abnahme (Seite „Aktionen“): Stand, in dem der Auftrag steckt – den
      // Commit bestimmt der Worker beim Start (Sprint-Branch bzw. main), weil nur er das Repository sieht.
      const approval = item?.status === DEVELOPMENT_STATUS.approval;
      if (!item || (!approval && item.status === DEVELOPMENT_STATUS.inProgress)) {
        response.status(409).json({ message: 'Der Auftrag läuft gerade – erst danach im Review-Container prüfbar.' });
        return;
      }
      const slot = await requestSlot(pool, item.slug, {
        commit: null,
        label: `${approval ? 'Freigabe' : 'Abnahme'}: ${item.title}`.slice(0, 200),
        developmentId: request.params.id,
        kind: approval ? 'approval' : 'manual',
        slot: wanted,
      });
      if (!slot) {
        response.status(409).json({ message: noSlotMessage(wanted) });
        return;
      }
      response.json({ ok: true, slot });
    },
  );
}
