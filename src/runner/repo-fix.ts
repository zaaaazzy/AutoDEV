import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type CommandExecutor, runCommand } from '../core/command.js';
import { withProjectLock } from '../core/project-lock.js';
import { checkedOutElsewhere, gitHelpers, stageAll } from './git-sync.js';
import { type GitFix, MAIN } from './repo-state.js';

/**
 * Lösungen für die Befunde aus repo-state.ts, auf Knopfdruck vom Worker ausgeführt. Grundsätze: nie etwas verwerfen,
 * nie force-pushen, bei Konflikten abbrechen und melden. Liefert eine Zusammenfassung für die Oberfläche.
 */
export async function applyGitFix(
  fix: GitFix,
  folder: string,
  rawExecute: CommandExecutor = runCommand,
  now: Date = new Date(),
): Promise<string> {
  const execute: CommandExecutor = (command, directory, options) =>
    withProjectLock(folder, () => rawExecute(command, directory, options));
  switch (fix) {
    case 'save_wip':
      return saveWorkInProgress(folder, execute, now);
    case 'checkout_main':
      return checkoutMain(folder, execute);
    case 'sync_main':
      return syncMain(folder, execute);
  }
}

/** Offene Änderungen committen. Auf main nicht dort, sondern auf einem neuen Branch wip/…, danach zurück auf main. */
async function saveWorkInProgress(folder: string, execute: CommandExecutor, now: Date): Promise<string> {
  const { git, must } = gitHelpers(execute, folder);
  const head = await git('symbolic-ref', '--short', '-q', 'HEAD');
  const branch = head.exitCode === 0 ? head.output : null;
  const stamp = now
    .toISOString()
    .slice(0, 16)
    .replace(/[-:T]/g, '')
    .replace(/^(\d{8})/, '$1-');
  let target = branch;
  if (!branch || branch === MAIN) {
    target = `wip/${stamp}`;
    await must('switch', '-c', target);
  }
  const held = await stageAll(git, must, []);
  const staged = await git('diff', '--cached', '--name-only');
  if (!staged.output) {
    if (target !== branch && branch) await must('switch', branch);
    return held.length
      ? `Nichts gesichert: Die offenen Dateien sehen nach Zugangsdaten aus (${held.join(', ')}) und bleiben unversioniert.`
      : 'Nichts zu sichern – der Ordner hat keine offenen Änderungen.';
  }
  const count = staged.output.split('\n').filter(Boolean).length;
  await must(
    'commit',
    '-q',
    '-m',
    `WIP: Zwischenstand gesichert (${count} Datei${count === 1 ? '' : 'en'})`,
    '-m',
    'Von AIdeation auf Knopfdruck gesichert, damit der Projektordner wieder sauber ist.',
  );
  const commit = await must('rev-parse', '--short', 'HEAD');
  if (target !== branch && branch) await must('switch', branch);
  return [
    `${count} Datei${count === 1 ? '' : 'en'} auf ${target} gesichert (Commit ${commit}).`,
    target !== branch ? `Der Ordner steht wieder sauber auf ${MAIN}.` : '',
    held.length ? `Nicht gesichert, weil sie nach Zugangsdaten aussehen: ${held.join(', ')}.` : '',
  ]
    .filter(Boolean)
    .join(' ');
}

/** Zurück auf main – nur ohne offene Änderungen an versionierten Dateien (neue Dateien wandern mit). */
async function checkoutMain(folder: string, execute: CommandExecutor): Promise<string> {
  const { git, must } = gitHelpers(execute, folder);
  if ((await git('status', '--porcelain', '--untracked-files=no')).output) {
    throw new Error('Im Ordner sind Änderungen offen – zuerst „Zwischenstand sichern“.');
  }
  const elsewhere = await checkedOutElsewhere(git, MAIN, folder);
  if (elsewhere) throw new Error(`${MAIN} ist schon in ${elsewhere} ausgecheckt.`);
  const before = (await git('symbolic-ref', '--short', '-q', 'HEAD')).output || 'losgelöster Stand';
  await must('switch', MAIN);
  return `Von ${before} auf ${MAIN} gewechselt. Der Branch ${before} bleibt erhalten.`;
}

/**
 * main mit GitHub abgleichen: holen, zusammenführen (Fast-Forward oder Merge-Commit) und normal pushen. Ist main in
 * einem Ordner ausgecheckt, passiert der Merge dort (nur ohne offene Änderungen), sonst in einem kurzlebigen Worktree.
 */
async function syncMain(folder: string, execute: CommandExecutor): Promise<string> {
  const { git, must } = gitHelpers(execute, folder);
  await must('fetch', '-q', 'origin', MAIN);
  const counts = (await must('rev-list', '--left-right', '--count', `${MAIN}...origin/${MAIN}`))
    .split(/\s+/)
    .map(Number);
  const ahead = counts[0] ?? 0;
  const behind = counts[1] ?? 0;
  if (!ahead && !behind) return `${MAIN} stimmt bereits mit GitHub überein.`;
  const own = (await git('symbolic-ref', '--short', '-q', 'HEAD')).output === MAIN ? folder : null;
  let mergeFolder = own ?? (await checkedOutElsewhere(git, MAIN, folder));
  let temporary: string | null = null;
  try {
    if (behind) {
      if (!mergeFolder && !ahead) {
        // Nicht ausgecheckt und nur zurück: Referenz per Fast-Forward nachziehen.
        await must('fetch', '-q', 'origin', `${MAIN}:${MAIN}`);
      } else {
        if (!mergeFolder) {
          temporary = await mkdtemp(join(tmpdir(), 'aideation-main-'));
          await must('worktree', 'add', '-q', temporary, MAIN);
          mergeFolder = temporary;
        }
        const there = gitHelpers(execute, mergeFolder);
        if ((await there.git('status', '--porcelain', '--untracked-files=no')).output) {
          throw new Error(`In ${mergeFolder} (dort ist ${MAIN} ausgecheckt) sind Änderungen offen – zuerst sichern.`);
        }
        const merged = await there.git('merge', '--no-edit', `origin/${MAIN}`);
        if (merged.exitCode !== 0) {
          await there.git('merge', '--abort');
          throw new Error(
            `Konflikt beim Zusammenführen von ${MAIN} mit GitHub – bitte von Hand lösen. ${merged.output.slice(-300)}`,
          );
        }
      }
    }
    if (ahead) await must('push', '-q', 'origin', `${MAIN}:${MAIN}`);
  } finally {
    if (temporary) {
      await git('worktree', 'remove', '--force', temporary);
      await rm(temporary, { recursive: true, force: true });
    }
  }
  return [
    behind ? `${behind} Commit${behind === 1 ? '' : 's'} von GitHub übernommen.` : '',
    ahead ? `${ahead} lokale${ahead === 1 ? 'r' : ''} Commit${ahead === 1 ? '' : 's'} nach GitHub gepusht.` : '',
  ]
    .filter(Boolean)
    .join(' ');
}
