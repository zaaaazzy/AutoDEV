import { existsSync } from 'node:fs';
import { rename, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { runCommand } from '../../core/command.js';

/**
 * Verwaiste Sperrdatei (`index.lock`): Wird git hart beendet (Timeout, Neustart, Abbruch per SIGKILL), bleibt sie liegen
 * und jeder schreibende git-Befehl im Ordner scheitert („index.lock: File exists“). Eine Sperre gilt als verwaist, wenn
 * kein Prozess sie offen hält (git hält sie offen, solange es schreibt) und sie nicht ganz neu ist. Ohne `lsof`
 * (Windows) erst nach 10 Minuten. Sie wird umbenannt statt gelöscht, damit sie nachvollziehbar bleibt.
 */
const MIN_AGE_WITH_LSOF_MS = 30_000;
const MIN_AGE_WITHOUT_LSOF_MS = 10 * 60_000;

/** Fehlermeldung von git, die auf eine bestehende Sperrdatei hinweist (englisch oder deutsch). */
export function isIndexLockError(output: string): boolean {
  return /index\.lock/.test(output) && /(File exists|existiert|already exists)/i.test(output);
}

async function gitDirOf(cwd: string): Promise<string | null> {
  const result = await runCommand(['git', 'rev-parse', '--absolute-git-dir'], cwd, { timeoutMs: 15_000 }).catch(
    () => null,
  );
  const dir = result?.exitCode === 0 ? result.output.trim().split('\n').at(-1)?.trim() : '';
  return dir && isAbsolute(dir) ? dir : null;
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

/**
 * Räumt eine verwaiste `index.lock` im Git-Verzeichnis des Ordners weg. `minAgeMs` überschreibt die Mindestalter
 * (z. B. 0 beim Start des Workers, wenn alle alten Prozesse schon beendet sind). Liefert eine Meldung oder null.
 */
export async function clearStaleIndexLock(
  cwd: string,
  now: number = Date.now(),
  options: { minAgeMs?: number } = {},
): Promise<string | null> {
  const gitDir = await gitDirOf(cwd);
  if (!gitDir) return null;
  const lock = join(gitDir, 'index.lock');
  if (!existsSync(lock)) return null;
  const open = await heldOpen(lock);
  if (open) return null;
  const minAge = options.minAgeMs ?? (open === false ? MIN_AGE_WITH_LSOF_MS : MIN_AGE_WITHOUT_LSOF_MS);
  const info = await stat(lock).catch(() => null);
  if (!info || now - info.mtimeMs < minAge) return null;
  const parked = `${lock}.stale-${new Date(now).toISOString().replace(/[:.]/g, '-')}`;
  await rename(lock, parked);
  const message = `Verwaiste Git-Sperre entfernt: ${lock} (seit ${new Date(info.mtimeMs).toLocaleString('de-CH')}, aufbewahrt als ${parked}).`;
  console.warn(message);
  return message;
}
