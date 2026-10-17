import type { Pool } from 'pg';
import { type CommandExecutor, runCommand } from '../core/command.js';
import { agentEnvironment } from './runner-prompts.js';

const DEPLOY_TIMEOUT_MS = 20 * 60_000;

/** Runs the project's deploy commands (e.g. "docker compose up -d --build") so running containers match the code. */
export async function deployProject(
  pool: Pool,
  project: string,
  cwd: string,
  execute: CommandExecutor = runCommand,
): Promise<boolean | null> {
  const row = (
    await pool.query<{ commands: string[][] | null }>(
      `SELECT deploy_commands AS commands FROM projects WHERE slug = $1`,
      [project],
    )
  ).rows[0];
  const commands = row?.commands;
  if (!commands?.length) return null;
  const stamp = (): string => new Date().toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' });
  for (const command of commands) {
    console.info(`[${project}] Deploy: ${command.join(' ')}`);
    const result = await execute(command, cwd, { timeoutMs: DEPLOY_TIMEOUT_MS, env: agentEnvironment() }).catch(
      (error: unknown) => ({ exitCode: 1, output: error instanceof Error ? error.message : String(error) }),
    );
    if (result.exitCode !== 0) {
      const tail = result.output.trim().split('\n').slice(-3).join(' ').slice(0, 300);
      await pool.query(`UPDATE projects SET deploy_status = $2 WHERE slug = $1`, [
        project,
        `Fehlgeschlagen um ${stamp()}: ${command.join(' ')} – ${tail}`,
      ]);
      return false;
    }
  }
  await pool.query(`UPDATE projects SET deploy_status = $2 WHERE slug = $1`, [project, `Aktualisiert um ${stamp()}`]);
  return true;
}
