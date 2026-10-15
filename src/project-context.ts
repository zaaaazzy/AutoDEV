import type { Pool } from 'pg';

/** Projektbeschreibung und Regeln, die jeder Agent beachten muss. Leer, wenn nichts hinterlegt ist. */
export async function loadProjectContext(pool: Pool, slug: string): Promise<string> {
  const row = (await pool.query<{ name: string; description: string; guidelines: string }>(
    `SELECT name, description, guidelines FROM projects WHERE slug = $1`, [slug],
  ).catch(() => ({ rows: [] }))).rows[0];
  const description = row?.description?.trim() ?? '';
  const guidelines = row?.guidelines?.trim() ?? '';
  if (!row || (!description && !guidelines)) return '';
  return [
    description ? `## Projekt „${row.name}“\n${description}` : '',
    guidelines ? `## Verbindliche Regeln (Do's and Don'ts) – unbedingt einhalten\n${guidelines}` : '',
  ].filter(Boolean).join('\n\n');
}

export const withProjectContext = (context: string, prompt: string): string =>
  context ? `${context}\n\n${prompt}` : prompt;
