// Datenzugriff für Bugs, den Worker und Agents ohne die Routen brauchen (Bug-Bericht eines Agents, bekannte Bugs für den Prompt).
import type { Pool } from 'pg';
import { categoryFromBug } from '../core/bug-category.js';
import { unapprovedBugSql } from '../core/bug-trust.js';
import type { KnownBug } from '../core/known-bugs.js';
import { BUG_STATUS } from '../core/status.js';

/** Creates a bug report for a failed agent step unless an identical open bug already exists. */
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
  },
): Promise<string> {
  const title = bug.title.slice(0, 180);
  const description = bug.description.slice(0, 10_000);
  const category = bug.category ?? categoryFromBug({ title, description, paths: bug.paths });
  // development_id: Ist der Auftrag später doch erledigt, kommt die Meldung auf den Friedhof (Trigger).
  const created = await pool.query<{ id: string }>(
    `INSERT INTO bugs (project_slug, title, description, severity, source, sprint_id, development_id, category)
     SELECT $1, $2, $3, 'high', 'agent', NULL, $4, $5
      WHERE NOT EXISTS (
        SELECT 1 FROM bugs WHERE project_slug = $1 AND title = $2 AND status IN ('${BUG_STATUS.open}', '${BUG_STATUS.inProgress}')
      ) RETURNING id`,
    [bug.projectSlug, title, description, bug.developmentId ?? null, category],
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
