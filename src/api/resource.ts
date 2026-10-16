import type { Pool } from 'pg';

type ProjectScopedEntity = 'bugs' | 'development_items';

/** Checks a related sprint's project against the project of a bug or development item. */
export async function relatedResourceBelongsToProject(
  pool: Pool,
  entity: ProjectScopedEntity,
  relatedId: string,
  entityId: string,
): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1 FROM sprints s JOIN ${entity} e ON e.project_slug = s.project_slug
      WHERE s.id = $1 AND e.id = $2`,
    [relatedId, entityId],
  );
  return result.rows[0] !== undefined;
}
