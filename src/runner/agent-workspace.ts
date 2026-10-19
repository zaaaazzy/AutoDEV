import { existsSync, lstatSync, readdirSync, realpathSync, symlinkSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { type CommandExecutor, runCommand } from '../core/command.js';

/**
 * Eigener Arbeitsbaum für die Agents, wenn der Projektordner der Ordner ist, aus dem Dev Log selbst läuft.
 * Dort arbeiten Menschen (und andere Sitzungen) direkt; Branch-Wechsel und WIP-Commits der Aufträge würden ihre offenen
 * Änderungen mitnehmen und den laufenden Worker auf einen anderen Code-Stand setzen. Die Agents arbeiten deshalb in
 * einem Git-Worktree daneben (z. B. /Volumes/External/DevLog-agents); Branches und Historie sind dieselben.
 */
export function agentWorkspacePath(folder: string): string {
  return join(dirname(folder), `${basename(folder)}-agents`);
}

const same = (left: string, right: string): boolean => {
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return false;
  }
};

/** Abhängigkeiten nicht neu installieren: node_modules des Hauptordners verlinken (Wurzel und erste Ebene). */
function linkDependencies(folder: string, workspace: string): void {
  const candidates = [
    '.',
    ...readdirSync(folder, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules')
      .map((entry) => entry.name),
  ];
  for (const directory of candidates) {
    const source = join(folder, directory, 'node_modules');
    const target = join(workspace, directory, 'node_modules');
    if (!existsSync(source) || !existsSync(join(workspace, directory))) continue;
    try {
      lstatSync(target);
    } catch {
      symlinkSync(source, target, 'dir');
    }
  }
}

/**
 * Ordner, in dem die Agents eines Projekts arbeiten: der Projektordner selbst – ausser es ist der Dev-Log-Ordner oder
 * das Projekt verlangt einen eigenen Arbeitsordner (projects.agent_workspace, z. B. weil im Projektordner ein
 * Entwicklungsserver läuft), dann ein eigener Worktree (bei Bedarf angelegt, ausgehend von main). Scheitert das Anlegen, wird null geliefert;
 * die Agents bleiben dann gestoppt, statt im Arbeitsordner der Menschen zu arbeiten.
 */
export async function resolveAgentWorkspace(
  folder: string,
  installRoot: string,
  execute: CommandExecutor = runCommand,
  separate = false,
): Promise<{ cwd: string | null; problem: string | null }> {
  if (!separate && !same(folder, installRoot)) return { cwd: folder, problem: null };
  const workspace = agentWorkspacePath(folder);
  if (!existsSync(join(workspace, '.git'))) {
    const hasMain =
      (await execute(['git', 'rev-parse', '--verify', '--quiet', 'refs/heads/main'], folder)).exitCode === 0;
    const created = await execute(
      ['git', 'worktree', 'add', '--detach', workspace, ...(hasMain ? ['main'] : [])],
      folder,
      { timeoutMs: 120_000 },
    );
    if (created.exitCode !== 0) {
      return {
        cwd: null,
        problem: `Eigener Arbeitsbaum für die Agents konnte nicht angelegt werden (${workspace}): ${created.output.slice(-300)}`,
      };
    }
  }
  try {
    linkDependencies(folder, workspace);
  } catch {
    // Ohne verlinkte Abhängigkeiten installieren die Agents sie bei Bedarf selbst.
  }
  return { cwd: workspace, problem: null };
}
