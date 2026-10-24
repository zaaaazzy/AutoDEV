import { existsSync } from 'node:fs';
import { rename, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { runCommand } from '../../core/command.js';

/**
 * Verwaiste Sperrdateien (`index.lock`, `AUTO_MERGE.lock`, `HEAD.lock`, Ref-Sperren …): Wird git hart beendet (Timeout,
 * Neustart, Abbruch per SIGKILL), bleiben sie liegen und jeder schreibende git-Befehl im Ordner scheitert („….lock: File
 * exists“; bei `AUTO_MERGE.lock` nur als „Merge mit Strategie ort fehlgeschlagen“). Eine Sperre gilt als verwaist, wenn
 * kein Prozess sie offen hält (git hält sie offen, solange es schreibt) und sie nicht ganz neu ist. Ohne `lsof`
 * (Windows) erst nach 10 Minuten. Sie wird umbenannt statt gelöscht, damit sie nachvollziehbar bleibt.
 */
const MIN_AGE_WITH_LSOF_MS = 30_000;
const MIN_AGE_WITHOUT_LSOF_MS = 10 * 60_000;

/** Sperren, die beim Start ohne Fehlermeldung geprüft werden: im Git-Verzeichnis des Worktrees und im gemeinsamen. */
const WORKTREE_LOCKS = ['index.lock', 'HEAD.lock', 'AUTO_MERGE.lock', 'ORIG_HEAD.lock', 'MERGE_HEAD.lock'];
const COMMON_LOCKS = ['HEAD.lock', 'packed-refs.lock', 'config.lock'];

/** Fehlermeldung von git, die auf eine bestehende Sperrdatei hinweist (englisch oder deutsch). */
export function isGitLockError(output: string): boolean {
  return /\.lock\b/.test(output) && /(File exists|existiert|already exists)/i.test(output);
}

/** Absolute Pfade der Sperrdateien, die git in der Fehlermeldung nennt („Unable to create '/…/x.lock'“). */
export function locksInError(output: string): string[] {
  return [...output.matchAll(/'([^']+\.lock)'/g)].map((match) => match[1]!).filter((path) => isAbsolute(path));
}

async function gitDirsOf(cwd: string): Promise<{ gitDir: string; commonDir: string } | null> {
  const result = await runCommand(
    ['git', 'rev-parse', '--absolute-git-dir', '--path-format=absolute', '--git-common-dir'],
    cwd,
    { timeoutMs: 15_000 },
  ).catch(() => null);
  const [gitDir, commonDir] = result?.exitCode === 0 ? result.output.trim().split('\n').slice(-2) : [];
  return gitDir && commonDir && isAbsolute(gitDir.trim()) && isAbsolute(commonDir.trim())
    ? { gitDir: resolve(gitDir.trim()), commonDir: resolve(commonDir.trim()) }
    : null;
}

/** Hält ein Prozess die Datei offen? null = nicht feststellbar (kein lsof). */
async function heldOpen(file: string): Promise<boolean | null> {
  if (process.platform === 'win32') return null;
  const result = await runCommand(['lsof', '-t', '--', file], '/', { timeoutMs: 15_000 }).catch(() => null);
  if (!result) return null;
  // lsof: Exit 0 mit PIDs = offen; Exit 1 ohne Ausgabe = von niemandem geöffnet.
  if (result.exitCode === 0) return result.output.trim().length > 0;
  return result.output.trim() ? null : false;
}

async function clearIfStale(lock: string, now: number, minAgeMs: number | undefined): Promise<string | null> {
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
 * Räumt verwaiste Sperren im Git-Verzeichnis des Ordners weg: die in `fromError` (Ausgabe eines gescheiterten
 * git-Befehls) genannten, sonst die üblichen (WORKTREE_LOCKS, COMMON_LOCKS). Nur Dateien innerhalb des Git-Verzeichnisses
 * oder des gemeinsamen Git-Verzeichnisses. `minAgeMs` überschreibt die Mindestalter (z. B. 0 beim Start des Workers,
 * wenn alle alten Prozesse schon beendet sind). Liefert eine Meldung oder null.
 */
export async function clearStaleGitLocks(
  cwd: string,
  now: number = Date.now(),
  options: { minAgeMs?: number; fromError?: string } = {},
): Promise<string | null> {
  const dirs = await gitDirsOf(cwd);
  if (!dirs) return null;
  const within = (path: string) =>
    [dirs.gitDir, dirs.commonDir].some((dir) => resolve(path).startsWith(`${dir}${sep}`));
  const candidates =
    options.fromError !== undefined
      ? locksInError(options.fromError).filter(within)
      : [
          ...WORKTREE_LOCKS.map((name) => join(dirs.gitDir, name)),
          ...COMMON_LOCKS.map((name) => join(dirs.commonDir, name)),
        ];
  const messages: string[] = [];
  for (const lock of new Set(candidates.map((path) => resolve(path)))) {
    const message = await clearIfStale(lock, now, options.minAgeMs);
    if (message) messages.push(message);
  }
  return messages.length ? messages.join('\n') : null;
}
