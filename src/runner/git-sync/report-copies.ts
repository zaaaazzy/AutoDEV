// Testberichte vor einem Checkout: unversionierte Kopien weichen, wenn das Ziel sie unverändert enthält.
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Ablage der Agent-Berichte (Tester und Test-Gate in docs/tests/, Bug-Wächter in docs/risiken/). Die einzige Liste
 * dieser Ordner: Sie liegen unversioniert, zählen nie als Änderung eines Auftrags (sonst pausierte der nächste Auftrag
 * den Sprint als „fremde Änderung“) und kommen mit der Sprint-Sicherung – durch den Secret-Holdback – ins Repository.
 */
export const REPORT_DIRECTORIES = ['docs/tests/', 'docs/risiken/'];

type GitRun = (...args: string[]) => Promise<{ exitCode: number; output: string }>;

/**
 * Ziel eines `git checkout …` (Branch, Tag oder Commit), ohne Optionen. Bei `-b name [start]` ist es der Startpunkt;
 * fehlt er, bleibt HEAD und es gibt nichts zu vergleichen (null).
 */
export function checkoutTarget(args: readonly string[]): string | null {
  const positional: string[] = [];
  let branchName = false;
  for (const arg of args[0] === 'checkout' ? args.slice(1) : args) {
    if (arg === '--') break;
    if (branchName) branchName = false;
    else if (arg === '-b' || arg === '-B') branchName = true;
    else if (!arg.startsWith('-')) positional.push(arg);
  }
  return positional.at(-1) ?? null;
}

/**
 * Entfernt unversionierte Berichte (REPORT_DIRECTORIES), die `target` mit exakt gleichem Inhalt enthält. Sonst bricht der
 * Checkout ab („unversionierte Dateien … würden überschrieben“): Der Bericht liegt im Agent-Ordner noch lose, ist
 * aber inzwischen auf main committet. Abweichende oder im Ziel fehlende Dateien bleiben liegen. Gibt die entfernten
 * Pfade zurück.
 */
export async function dropReportCopies(git: GitRun, cwd: string, target: string): Promise<string[]> {
  const listed = await git('ls-files', '-z', '--others', '--exclude-standard', '--', ...REPORT_DIRECTORIES);
  if (listed.exitCode !== 0) return [];
  const removed: string[] = [];
  for (const file of listed.output.split('\0').filter(Boolean)) {
    const inTarget = await git('rev-parse', '--verify', '--quiet', `${target}:${file}`);
    if (inTarget.exitCode !== 0) continue;
    const local = await git('hash-object', '--', file);
    if (local.exitCode !== 0 || local.output.trim() !== inTarget.output.trim()) continue;
    await rm(join(cwd, file), { force: true });
    removed.push(file);
  }
  if (removed.length) console.warn(`Berichte entfernt, die ${target} unverändert enthält: ${removed.join(', ')}`);
  return removed;
}
