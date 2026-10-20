import type { Pool } from 'pg';
import type { CommandExecutor } from '../core/command.js';
import { deployProject } from './deploy.js';
import { followProjectPreview } from './review-gate.js';

/**
 * Live schalten (nach dem Go zum Sprint, wenn er in main gemergt ist – direkt oder über den Pull Request):
 * Projektordner (z. B. mit dev-live) auf main nachziehen und die Deploy-Befehle des Projekts dort ausführen. Vorher
 * sieht man den Sprint nur in der Vorschau. Liefert das Ergebnis des Deploys: true = deployt, false = fehlgeschlagen,
 * null = keine Deploy-Befehle hinterlegt.
 */
export async function goLive(
  pool: Pool,
  project: string,
  cwd: string,
  execute?: CommandExecutor,
): Promise<boolean | null> {
  await followProjectPreview(pool, project, cwd, 'main', execute);
  const live = (await pool.query<{ repository: string }>('SELECT repository FROM projects WHERE slug = $1', [project]))
    .rows[0]?.repository;
  return deployProject(pool, project, live ?? cwd, execute);
}
