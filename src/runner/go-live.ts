import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { type CommandExecutor, runCommand } from '../core/command.js';
import { deployProject } from './deploy.js';
import { gitHelpers, MAIN_BRANCH } from './git-sync/git-helpers.js';
import { followProjectPreview } from './review-gate.js';

/**
 * Darf aus diesem Ordner deployt werden? Nur, wenn er auf main steht (oder losgelöst genau auf main) und keine
 * offenen Änderungen an versionierten Dateien hat. Sonst ginge der Stand eines fremden Branchs oder halbfertige Arbeit
 * live. Liefert den Grund oder null.
 */
export async function liveFolderProblem(folder: string, execute: CommandExecutor = runCommand): Promise<string | null> {
  if (!existsSync(join(folder, '.git'))) return null;
  const { git } = gitHelpers(execute, folder);
  const head = await git('symbolic-ref', '--short', '-q', 'HEAD');
  const branch = head.exitCode === 0 ? head.output : null;
  if (branch !== MAIN_BRANCH) {
    const here = (await git('rev-parse', 'HEAD')).output;
    const main = (await git('rev-parse', '--verify', '--quiet', MAIN_BRANCH)).output;
    if (branch || !main || here !== main) {
      return `Projektordner ${folder} steht auf ${branch ?? `einem losgelösten Stand (${here.slice(0, 7)})`} statt auf ${MAIN_BRANCH}`;
    }
  }
  const changes = (await git('--no-optional-locks', 'status', '--porcelain', '--untracked-files=no')).output;
  if (changes) {
    const count = changes.split('\n').filter(Boolean).length;
    return `Projektordner ${folder} hat ${count} offene Änderung${count === 1 ? '' : 'en'}`;
  }
  return null;
}

/**
 * Live schalten (nach dem Go zum Sprint, wenn er in main gemergt ist – direkt oder über den Pull Request):
 * Projektordner (z. B. mit dev-live) auf main nachziehen und die Deploy-Befehle des Projekts dort ausführen. Vorher
 * sieht man den Sprint nur in der Vorschau. Liefert das Ergebnis des Deploys: true = deployt, false = fehlgeschlagen,
 * null = keine Deploy-Befehle hinterlegt. Steht der Projektordner nicht sauber auf main, wird nicht deployt (Fehler).
 */
export async function goLive(
  pool: Pool,
  project: string,
  cwd: string,
  execute?: CommandExecutor,
): Promise<boolean | null> {
  await followProjectPreview(pool, project, cwd, 'main', execute);
  const live =
    (await pool.query<{ repository: string }>('SELECT repository FROM projects WHERE slug = $1', [project])).rows[0]
      ?.repository ?? cwd;
  const problem = await liveFolderProblem(live, execute);
  if (problem) {
    await pool.query(`UPDATE projects SET deploy_status = $2 WHERE slug = $1`, [project, `Nicht deployt: ${problem}.`]);
    throw new Error(
      `nicht deployt – ${problem}. Ordner aufräumen (Dashboard: Git-Hinweis), dann erneut live schalten.`,
    );
  }
  return deployProject(pool, project, live, execute);
}
