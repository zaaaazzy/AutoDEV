import { existsSync } from 'node:fs';
import { readdir, rename, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { runCommand } from '../../core/command.js';
import { gitEnvironment } from '../project-command.js';

/**
 * Verwaiste Sperrdatei (`index.lock`, `AUTO_MERGE.lock`, `HEAD.lock`, `refs/heads/….lock` …): Wird git hart beendet
 * (Timeout, Neustart, Abbruch per SIGKILL), bleibt sie liegen und jeder git-Befehl, der sie braucht, scheitert
 * („Unable to create '….lock': File exists“). Sprint 20: eine liegengebliebene `AUTO_MERGE.lock` liess jeden Merge im
 * Agent-Ordner scheitern, während Commits und Checkouts weiterliefen. Eine Sperre gilt als verwaist, wenn
 * kein Prozess sie offen hält (git hält sie offen, solange es schreibt) und sie nicht ganz neu ist. Ohne `lsof`
 * (Windows) erst nach 10 Minuten. Sie wird umbenannt statt gelöscht, damit sie nachvollziehbar bleibt.
 */
const MIN_AGE_WITH_LSOF_MS = 30_000;
const MIN_AGE_WITHOUT_LSOF_MS = 10 * 60_000;

/**
 * Sperrdatei aus einer Fehlermeldung von git (englisch oder deutsch), z. B. „Unable to create '/…/AUTO_MERGE.lock':
 * File exists.“ bzw. „Konnte '/…/index.lock' nicht erstellen: File exists.“ – sonst null.
 */
export function lockedFile(output: string): string | null {
  return output.match(/'([^'\n]+\.lock)'[^\n]*?(?:File exists|existiert|already exists)/i)?.[1] ?? null;
}

/** Eigenes Git-Verzeichnis des Ordners und das gemeinsame aller Worktrees (bei einem Haupt-Checkout dasselbe). */
async function gitDirsOf(cwd: string): Promise<{ gitDir: string; commonDir: string } | null> {
  const result = await runCommand(
    ['git', 'rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'],
    cwd,
    { timeoutMs: 15_000, env: gitEnvironment() },
  ).catch(() => null);
  const [gitDir, commonDir] = result?.exitCode === 0 ? result.output.trim().split('\n').slice(-2) : [];
  return gitDir && commonDir && isAbsolute(gitDir) && isAbsolute(commonDir)
    ? { gitDir: gitDir.trim(), commonDir: commonDir.trim() }
    : null;
}

const inside = (directory: string, file: string): boolean => {
  const path = relative(directory, file);
  return Boolean(path) && !path.startsWith('..') && !isAbsolute(path);
};

/** Hält ein Prozess die Datei offen? null = nicht feststellbar (kein lsof). */
async function heldOpen(file: string): Promise<boolean | null> {
  if (process.platform === 'win32') return null;
  const result = await runCommand(['lsof', '-t', '--', file], '/', { timeoutMs: 15_000 }).catch(() => null);
  if (!result) return null;
  // lsof: Exit 0 mit PIDs = offen; Exit 1 ohne Ausgabe = von niemandem geöffnet.
  if (result.exitCode === 0) return result.output.trim().length > 0;
  return result.output.trim() ? null : false;
}

/** Räumt eine Sperrdatei weg, wenn kein Prozess sie hält und sie mindestens `minAgeMs` alt ist. */
async function clearIfStale(lock: string, now: number, minAgeMs?: number): Promise<string | null> {
  if (!existsSync(lock)) return null;
  const open = await heldOpen(lock);
  if (open) return null;
  const minAge = minAgeMs ?? (open === false ? MIN_AGE_WITH_LSOF_MS : MIN_AGE_WITHOUT_LSOF_MS);
  const info = await stat(lock).catch(() => null);
  if (!info?.isFile() || now - info.mtimeMs < minAge) return null;
  const parked = `${lock}.stale-${new Date(now).toISOString().replace(/[:.]/g, '-')}`;
  await rename(lock, parked);
  const message = `Verwaiste Git-Sperre entfernt: ${lock} (seit ${new Date(info.mtimeMs).toLocaleString('de-CH')}, aufbewahrt als ${parked}).`;
  console.warn(message);
  return message;
}

/**
 * Räumt eine verwaiste Sperrdatei im Git-Verzeichnis des Ordners weg: `file` (aus der Fehlermeldung, siehe
 * {@link lockedFile}) oder `index.lock`. Dateien ausserhalb des eigenen bzw. gemeinsamen Git-Verzeichnisses werden nie
 * angefasst. `minAgeMs` überschreibt die Mindestalter. Liefert eine Meldung oder null.
 */
export async function clearStaleLock(
  cwd: string,
  options: { file?: string; now?: number; minAgeMs?: number } = {},
): Promise<string | null> {
  const dirs = await gitDirsOf(cwd);
  if (!dirs) return null;
  const lock = resolve(cwd, options.file ?? join(dirs.gitDir, 'index.lock'));
  if (!lock.endsWith('.lock') || !(inside(dirs.gitDir, lock) || inside(dirs.commonDir, lock))) return null;
  return clearIfStale(lock, options.now ?? Date.now(), options.minAgeMs);
}

async function lockFilesIn(directory: string, recursive: boolean): Promise<string[]> {
  const entries = await readdir(directory, { recursive }).catch((): string[] => []);
  return entries.filter((entry) => entry.endsWith('.lock')).map((entry) => join(directory, entry));
}

/**
 * Beim Start des Workers: alle verwaisten Sperren des Ordners wegräumen. Im eigenen Git-Verzeichnis (Index, HEAD,
 * AUTO_MERGE, ORIG_HEAD …) mit `minAgeMs` – es laufen keine alten git-Prozesse mehr. Refs und `packed-refs` liegen im
 * gemeinsamen Verzeichnis, das andere Worktrees (Menschen, andere Sitzungen) mitbenutzen: dort gilt immer das normale
 * Mindestalter. Index und HEAD anderer Worktrees werden nie angefasst.
 */
export async function clearStaleLocks(
  cwd: string,
  now: number = Date.now(),
  options: { minAgeMs?: number } = {},
): Promise<string[]> {
  const dirs = await gitDirsOf(cwd);
  if (!dirs) return [];
  const own = await lockFilesIn(dirs.gitDir, false);
  const shared = [
    ...(dirs.commonDir === dirs.gitDir ? [] : [join(dirs.commonDir, 'packed-refs.lock')]),
    ...(await lockFilesIn(join(dirs.commonDir, 'refs'), true)),
  ].filter((file) => !own.includes(file));
  const messages: string[] = [];
  for (const [files, minAgeMs] of [
    [own, options.minAgeMs],
    [shared, undefined],
  ] as const) {
    for (const file of files) {
      const message = await clearIfStale(file, now, minAgeMs).catch(() => null);
      if (message) messages.push(message);
    }
  }
  return messages;
}
