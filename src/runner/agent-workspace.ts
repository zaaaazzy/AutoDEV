import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { type CommandExecutor, runCommand } from '../core/command.js';
import { gitEnvironment } from './project-command.js';

/**
 * Eigener Arbeitsbaum für die Agents (Git-Worktree; Branches und Historie sind dieselben). Projekte liegen in
 * <Projekt>/source, die Agents arbeiten daneben in <Projekt>/agent. Ältere Projekte ohne diese Struktur bekommen
 * <Ordner>-agents daneben.
 */
export function agentWorkspacePath(folder: string): string {
  return basename(folder) === 'source'
    ? join(dirname(folder), 'agent')
    : join(dirname(folder), `${basename(folder)}-agents`);
}

const same = (left: string, right: string): boolean => {
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return false;
  }
};

const isLink = (path: string): boolean => {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
};

/** Verweist der Symlink (z. B. ein npm-Workspace-Paket) in den Projektordner selbst? */
function pointsInto(link: string, folder: string): boolean {
  try {
    const target = resolve(dirname(link), readlinkSync(link));
    const inside = relative(folder, target);
    return !inside.startsWith('..') && !isAbsolute(inside) && !inside.startsWith(`node_modules`);
  } catch {
    return false;
  }
}

/**
 * node_modules der Wurzel nachbauen: jedes Paket als Link auf den Hauptordner, ausser npm-Workspace-Pakete
 * (z. B. @mainty/contracts → ../../contracts). Die bekommen denselben relativen Link, zeigen also auf den Code im
 * Arbeitsordner statt auf den Stand im Hauptordner.
 */
/**
 * Ordner-Link: Unter Windows als Junction (braucht weder Admin-Rechte noch den Entwicklermodus, anders als ein
 * symbolischer Link), sonst ein normaler Ordner-Link.
 */
const DIRECTORY_LINK = process.platform === 'win32' ? 'junction' : 'dir';

function mirrorModules(source: string, target: string, folder: string): void {
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(target, entry.name);
    if (existsSync(to) || isLink(to)) continue;
    if (entry.isSymbolicLink() && pointsInto(from, folder)) {
      // Junctions brauchen ein absolutes Ziel; anderswo bleibt der relative Link (zeigt in den Arbeitsordner).
      const link = readlinkSync(from);
      symlinkSync(process.platform === 'win32' ? resolve(dirname(to), link) : link, to, DIRECTORY_LINK);
    } else if (entry.isDirectory() && entry.name.startsWith('@')) {
      mirrorModules(from, to, folder);
    } else {
      symlinkSync(from, to, entry.isDirectory() ? DIRECTORY_LINK : 'file');
    }
  }
}

function hasWorkspaceLinks(modules: string, folder: string): boolean {
  for (const entry of readdirSync(modules, { withFileTypes: true })) {
    const path = join(modules, entry.name);
    if (entry.isSymbolicLink() && pointsInto(path, folder)) return true;
    if (entry.isDirectory() && entry.name.startsWith('@') && hasWorkspaceLinks(path, folder)) return true;
  }
  return false;
}

/** Abhängigkeiten nicht neu installieren: node_modules des Hauptordners verlinken (Wurzel und erste Ebene). */
export function linkDependencies(folder: string, workspace: string): void {
  const rootSource = join(folder, 'node_modules');
  const rootTarget = join(workspace, 'node_modules');
  if (existsSync(rootSource) && hasWorkspaceLinks(rootSource, folder)) {
    // Früher als ein einziger Link angelegt: damit zeigten Workspace-Pakete in den Hauptordner.
    if (isLink(rootTarget)) rmSync(rootTarget);
    mirrorModules(rootSource, rootTarget, folder);
  }
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
      symlinkSync(source, target, DIRECTORY_LINK);
    }
  }
}

/**
 * Verlinkte node_modules sind Symlinks; ein `node_modules/` in .gitignore greift dafür nicht, und `git add -A` der
 * WIP-Commits würde sie einchecken. Deshalb lokal (info/exclude, gilt für alle Worktrees) ausschliessen.
 */
export async function excludeLinkedDependencies(workspace: string, execute: CommandExecutor): Promise<void> {
  const result = await execute(['git', 'rev-parse', '--git-common-dir'], workspace, { env: gitEnvironment() });
  if (result.exitCode !== 0) return;
  const common = result.output.trim().split('\n').pop() ?? '';
  const file = join(isAbsolute(common) ? common : join(workspace, common), 'info', 'exclude');
  const lines = existsSync(file) ? readFileSync(file, 'utf8').split('\n') : [];
  if (lines.some((line) => line.trim() === 'node_modules')) return;
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${lines.length && lines.at(-1) !== '' ? '\n' : ''}node_modules\n`);
}

/** Git-Worktree neben dem Projektordner anlegen (falls nötig) und Abhängigkeiten verlinken. */
export async function ensureWorktree(
  folder: string,
  workspace: string,
  execute: CommandExecutor = runCommand,
): Promise<string | null> {
  if (!existsSync(join(workspace, '.git'))) {
    const hasMain =
      (await execute(['git', 'rev-parse', '--verify', '--quiet', 'refs/heads/main'], folder, { env: gitEnvironment() }))
        .exitCode === 0;
    // Ohne Hooks: „worktree add“ startet sonst den post-checkout-Hook des Projekts.
    const created = await execute(
      ['git', 'worktree', 'add', '--detach', workspace, ...(hasMain ? ['main'] : [])],
      folder,
      { timeoutMs: 120_000, env: gitEnvironment() },
    );
    if (created.exitCode !== 0) return created.output.slice(-300) || 'git worktree add fehlgeschlagen';
  }
  try {
    linkDependencies(folder, workspace);
    await excludeLinkedDependencies(workspace, execute);
  } catch {
    // Ohne verlinkte Abhängigkeiten installieren die Agents sie bei Bedarf selbst.
  }
  return null;
}

/**
 * Ordner, in dem die Agents eines Projekts arbeiten: der Projektordner selbst – ausser es ist der AIdeation-Ordner oder
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
  const problem = await ensureWorktree(folder, workspace, execute);
  if (problem) {
    return {
      cwd: null,
      problem: `Eigener Arbeitsbaum für die Agents konnte nicht angelegt werden (${workspace}): ${problem}`,
    };
  }
  return { cwd: workspace, problem: null };
}
