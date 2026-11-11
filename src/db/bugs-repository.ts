// Datenzugriff für Bugs, den Worker und Agents ohne die Routen brauchen (Bug-Bericht eines Agents, bekannte Bugs für den Prompt).
import type { Pool } from 'pg';
import { categoryFromBug } from '../core/bug-category.js';
import { type BugCategoryValue, isBugCategoryValue } from '../core/bug-category-values.js';
import { unapprovedBugSql } from '../core/bug-trust.js';
import type { KnownBug } from '../core/known-bugs.js';
import { BUG_STATUS } from '../core/status.js';
import { TITLE_MAX, validText } from '../core/validation.js';

/**
 * Creates a bug report for a failed agent step unless an identical open bug already exists. Eine mitgegebene feste
 * Bug-Kategorie (aus der Liste) gilt als bestätigt; ohne sie holt der Aufrufer per afterBugCreated einen Vorschlag.
 */
export async function reportAgentBug(
  pool: Pool,
  bug: {
    projectSlug: string;
    title: string;
    description: string;
    sprintId?: string | null;
    developmentId?: string;
    paths?: string[];
    /** Kategorie, falls schon bekannt; sonst aus Titel, Beschreibung und Pfaden (src/core/bug-category.ts). */
    category?: string | null;
    bugCategory?: BugCategoryValue | null;
  },
): Promise<string> {
  const title = bug.title.slice(0, 180);
  const description = bug.description.slice(0, 10_000);
  const category = bug.category ?? categoryFromBug({ title, description, paths: bug.paths });
  const bugCategory = isBugCategoryValue(bug.bugCategory) ? bug.bugCategory : null;
  // development_id: Ist der Auftrag später doch erledigt, kommt die Meldung auf den Friedhof (Trigger).
  const created = await pool.query<{ id: string }>(
    `INSERT INTO bugs (project_slug, title, description, severity, source, sprint_id, development_id, category,
                       bug_category, bug_category_state)
     SELECT $1, $2, $3, 'high', 'agent', NULL, $4, $5, $6, CASE WHEN $6::text IS NOT NULL THEN 'confirmed' END
      WHERE NOT EXISTS (
        SELECT 1 FROM bugs WHERE project_slug = $1 AND title = $2 AND status IN ('${BUG_STATUS.open}', '${BUG_STATUS.inProgress}')
      ) RETURNING id`,
    [bug.projectSlug, title, description, bug.developmentId ?? null, category, bugCategory],
  );
  if (created.rows[0]) return created.rows[0].id;
  const existing = (
    await pool.query<{ id: string }>(
      `SELECT id FROM bugs WHERE project_slug = $1 AND title = $2 AND status IN ('${BUG_STATUS.open}', '${BUG_STATUS.inProgress}') ORDER BY created_at LIMIT 1`,
      [bug.projectSlug, title],
    )
  ).rows[0];
  if (!existing) throw new Error('Bug report could not be found after insertion.');
  return existing.id;
}

/**
 * Bug aus einem vom Menschen angenommenen Vorschlag (Quelle „agent“, ohne Sprint und ohne development_id: sonst
 * käme er per Trigger auf den Friedhof, sobald der Auftrag erledigt ist). Titel wie bei POST /bugs auf TITLE_MAX
 * begrenzt. Läuft in der Transaktion des Aufrufers; afterBugCreated erst nach dem Commit aufrufen.
 */
export async function insertProposalBug(
  db: Pick<Pool, 'query'>,
  bug: { projectSlug: string; title: string; description: string },
): Promise<{ id: string; category: string | null }> {
  if (!validText(bug.title, TITLE_MAX)) throw new Error('Titel des Vorschlags ist leer oder zu lang.');
  const description = bug.description.slice(0, 10_000);
  const category = categoryFromBug({ title: bug.title, description });
  const result = await db.query<{ id: string }>(
    `INSERT INTO bugs (project_slug, title, description, severity, source, sprint_id, category)
     VALUES ($1, $2, $3, 'medium', 'agent', NULL, $4) RETURNING id`,
    [bug.projectSlug, bug.title.trim(), description, category],
  );
  const row = result.rows[0];
  if (!row) throw new Error('Bug aus dem Vorschlag wurde nicht angelegt.');
  return { id: row.id, category };
}

/** Bekannte Bugs für den Prompt; fremde, nicht freigegebene Bugs (Betrieb, GitHub) kommen nicht in den Prompt. */
export async function loadKnownBugs(pool: Pool, projectSlug: string, limit = 40): Promise<KnownBug[]> {
  const result = await pool.query<KnownBug>(
    `SELECT title, description, severity, status, fix_notes AS "fixNotes", source
       FROM bugs
      WHERE project_slug = $1 AND status NOT IN ('${BUG_STATUS.wontfix}', '${BUG_STATUS.rejected}')
        AND NOT ${unapprovedBugSql('bugs')}
      ORDER BY CASE status WHEN '${BUG_STATUS.open}' THEN 0 WHEN '${BUG_STATUS.inProgress}' THEN 0 ELSE 1 END, updated_at DESC
      LIMIT $2`,
    [projectSlug, limit],
  );
  return result.rows;
}
