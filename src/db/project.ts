import type { Pool } from 'pg';
import { ensureDefaultAgents } from '../api/agents.js';

export async function registerProject(
  pool: Pool,
  project: { slug: string; name: string; repository: string },
): Promise<void> {
  await pool.query(
    `INSERT INTO projects (slug, name, repository)
     VALUES ($1, $2, $3)
     ON CONFLICT (slug) DO UPDATE
       SET name = EXCLUDED.name, repository = EXCLUDED.repository`,
    [project.slug, project.name, project.repository],
  );
  await ensureDefaultAgents(pool, project.slug);
}
