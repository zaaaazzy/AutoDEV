// Auftrags-Branches: anlegen, nach jedem Agent committen, abschliessen, mergen und geänderte Dateien ermitteln.
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withProjectLock } from '../../core/project-lock.js';
import { type CommandExecutor, runCommand } from '../../core/command.js';
import {
  backupWorkingTree,
  branchExists,
  briefGitError,
  CHANGED_FILES_IGNORED,
  checkedOutElsewhere,
  checkoutSprintBranch,
  currentBranch,
  ensureRepository,
  gitHelpers,
  type GitHelpers,
  MAIN_BRANCH,
  porcelainPath,
  refreshSprintFromMain,
  trackedChanges,
  slugify,
  sprintBranch,
  stageAll,
  taskCommitMessage,
} from './git-helpers.js';

/** Branch eines Auftrags, z. B. auftrag/1a2b3c4d-login-seite. */
export function orderBranch(item: { id: string; title: string }): string {
  return `auftrag/${item.id.slice(0, 8)}-${slugify(item.title).slice(0, 32)}`;
}

export interface OrderBranch {
  branch: string;
  base: string;
  /** Offene Merge-Konflikte mit der Basis (Dateien): Der nächste Agent, der Dateien ändert, löst sie. */
  conflicts?: string[];
}

// Beginn und Ende eines Konfliktblocks; eine einzelne Zeile „=======“ (z. B. Markdown-Unterstreichung) zählt nicht.
const CONFLICT_START = /^<{7} /m;
const CONFLICT_END = /^>{7} /m;

/**
 * Dateien mit ungelöstem Merge-Konflikt, die noch Konfliktmarker enthalten. Ohne laufenden Merge: leer.
 * Gelöste, aber noch nicht gestagte Dateien zählen nicht (der Commit nach dem Agent schliesst den Merge ab).
 */
export async function unresolvedConflicts(cwd: string, rawExecute: CommandExecutor = runCommand): Promise<string[]> {
  const { git } = gitHelpers(rawExecute, cwd);
  const unmerged = (await git('diff', '--name-only', '--diff-filter=U')).output
    .split('\n')
    .map((file) => file.trim())
    .filter(Boolean);
  const open: string[] = [];
  for (const file of unmerged) {
    const content = await readFile(join(cwd, file), 'utf8').catch(() => '');
    if (CONFLICT_START.test(content) && CONFLICT_END.test(content)) open.push(file);
  }
  return open;
}

/** Erste Aufgabe für den Agent, wenn der Auftrags-Branch beim Nachziehen der Basis Konflikte bekam. */
export function conflictPrompt(branch: OrderBranch): string {
  return [
    '## Zuerst: Merge-Konflikte lösen',
    `Beim Nachziehen von \`${branch.base}\` in den Auftrags-Branch \`${branch.branch}\` gab es Konflikte. Der Merge ist`,
    'noch offen, die Dateien enthalten Konfliktmarker (<<<<<<<, =======, >>>>>>>):',
    ...(branch.conflicts ?? []).map((file) => `- \`${file}\``),
    '',
    'Löse jeden Konflikt so, dass die Absicht beider Seiten erhalten bleibt (beide Ergänzungen übernehmen, doppelte',
    'Felder oder Importe nur einmal). Entferne alle Konfliktmarker und prüfe danach Typen und Tests. Führe selbst',
    'keine git-Befehle aus: AIdeation committet den Merge nach deinem Schritt. Danach erst die eigentliche Aufgabe.',
  ].join('\n');
}

/** Der Auftrag konnte nicht auf seinen eigenen Branch wechseln; er darf dann nicht weiterarbeiten (sonst landen seine Commits auf einem fremden Branch). */
export class OrderBranchError extends Error {
  override name = 'OrderBranchError';
}

/** Offene Änderungen im Arbeitsordner, die zu keinem Auftrag gehören (Testberichte und Agent-Ablage ausgenommen). */
async function foreignChanges(git: GitHelpers['git']): Promise<string[]> {
  const status = await git('-c', 'core.quotePath=false', 'status', '--porcelain', '--untracked-files=all');
  if (status.exitCode !== 0) return [];
  return status.output
    .split('\n')
    .map(porcelainPath)
    .filter((path) => path && !CHANGED_FILES_IGNORED.some((prefix) => path.startsWith(prefix)));
}

/**
 * Wechselt für einen Auftrag auf seinen eigenen Branch: bei Sprint-Aufträgen vom Sprint-Branch abgezweigt, sonst vom
 * aktuellen Branch. Existiert der Branch schon (erneuter Versuch), wird er fortgesetzt und der Basis-Stand eingemergt.
 * Gelingt das nicht, wirft sie OrderBranchError – nie arbeitet ein Auftrag auf main, dem Sprint oder einem fremden
 * Auftrags-Branch weiter. Projekte ohne Git: null.
 */
export async function enterOrderBranch(
  cwd: string,
  item: { id: string; title: string },
  sprintName: string | null,
  rawExecute: CommandExecutor = runCommand,
): Promise<OrderBranch | null> {
  const execute: CommandExecutor = (command, directory, options) =>
    withProjectLock(cwd, () => rawExecute(command, directory, options));
  const { git, must } = gitHelpers(execute, cwd);
  // Projekte ohne Git (bewusst gewählt) bekommen keinen Auftrags-Branch.
  if (!existsSync(join(cwd, '.git'))) return null;
  try {
    await ensureRepository(git, must, cwd);
    const branch = orderBranch(item);
    if ((await currentBranch(git)) === branch) {
      // Nach einem Abbruch steht der Ordner noch auf dem Auftrags-Branch (samt offener Änderungen): fortsetzen.
      return { branch, base: sprintName ? sprintBranch(sprintName) : MAIN_BRANCH };
    }
    // Was jetzt noch offen ist, stammt nicht von diesem Auftrag (Assistent, Mensch, abgebrochener anderer Auftrag)
    // und würde sonst mit „git add -A“ in seinen Commits landen.
    const foreign = await foreignChanges(git);
    if (foreign.length) {
      throw new OrderBranchError(
        `Im Arbeitsordner ${cwd} liegen fremde, nicht committete Änderungen (${foreign.slice(0, 8).join(', ')}${foreign.length > 8 ? ', …' : ''}) – bitte committen oder verwerfen.`,
      );
    }
    // Losgelöster Agent-Worktree, main ist im Ordner der Menschen ausgecheckt: Der Auftrag ohne Sprint zweigt direkt
    // von main ab (ohne main hier auszuchecken); finishOrderBranch mergt am Ende in den anderen Ordner.
    let detachedBase: string | null = null;
    if (sprintName) {
      if (!(await checkoutSprintBranch(cwd, sprintName, rawExecute))) {
        throw new OrderBranchError(`Sprint-Branch ${sprintBranch(sprintName)} lässt sich nicht auschecken.`);
      }
      // Vor jedem neuen Auftrag: aktuellen main in den Sprint-Branch holen (Konflikte früh und klein statt am Ende).
      const refreshed = await refreshSprintFromMain(git, sprintBranch(sprintName));
      if (refreshed) console.info(`[${item.id}] ${refreshed}`);
    } else if ((await currentBranch(git)) === 'HEAD' && (await branchExists(git, MAIN_BRANCH))) {
      // Losgelöst (z. B. nach dem kompletten Test): der Auftrag ohne Sprint arbeitet auf main auf.
      if (await checkedOutElsewhere(git, MAIN_BRANCH, cwd)) detachedBase = MAIN_BRANCH;
      else await must('checkout', MAIN_BRANCH);
    }
    const base = detachedBase ?? (await currentBranch(git));
    // Sprint-Aufträge zweigen nur vom Sprint-Branch ab: sonst landete der Merge am Ende z. B. direkt in main.
    if (sprintName && base !== sprintBranch(sprintName)) {
      throw new OrderBranchError(`Arbeitsordner ${cwd} steht auf ${base} statt auf ${sprintBranch(sprintName)}.`);
    }
    // Nie von einem losgelösten Stand oder vom Branch eines anderen Auftrags abzweigen: der Merge am Ende ginge ins Leere
    // bzw. in den fremden Auftrag statt in den Sprint.
    if (base === 'HEAD' || base.startsWith('auftrag/')) {
      throw new OrderBranchError(
        base === 'HEAD'
          ? `Arbeitsordner ${cwd} ist losgelöst (detached HEAD) – kein Basis-Branch für ${branch}.`
          : `Arbeitsordner ${cwd} steht noch auf dem fremden Auftrags-Branch ${base}.`,
      );
    }
    if (detachedBase) {
      if (await branchExists(git, branch)) {
        await must('checkout', branch);
        const merged = await git('merge', '--no-edit', detachedBase);
        if (merged.exitCode !== 0) {
          const conflicts = await unresolvedConflicts(cwd, execute);
          if (conflicts.length) return { branch, base: detachedBase, conflicts };
          await git('merge', '--abort');
        }
      } else {
        await must('checkout', '-b', branch, detachedBase);
      }
    } else if (!(await git('rev-parse', '--verify', '--quiet', 'HEAD')).exitCode) {
      if (await branchExists(git, branch)) {
        await must('checkout', branch);
        const merged = await git('merge', '--no-edit', base);
        if (merged.exitCode !== 0) {
          // Konflikte bleiben stehen: Der Entwickler löst sie (statt den Branch erneut am Merge scheitern zu lassen).
          const conflicts = await unresolvedConflicts(cwd, execute);
          if (conflicts.length) return { branch, base, conflicts };
          await git('merge', '--abort');
        }
      } else {
        await must('checkout', '-b', branch);
      }
    } else {
      // Leeres Repository ohne Commit: Branch direkt anlegen.
      await must('checkout', '-b', branch);
    }
    return { branch, base };
  } catch (error) {
    const message = `Auftrags-Branch für ${item.id} nicht aktiv: ${error instanceof Error ? error.message : String(error)}`;
    console.error(message);
    throw error instanceof OrderBranchError ? error : new OrderBranchError(message);
  }
}

/**
 * Schließt den Auftrags-Branch ab. Erfolg: Commit, Merge (--no-ff) in den Basis-Branch, Branch löschen.
 * Misserfolg: Zwischenstand als WIP-Commit auf dem Auftrags-Branch sichern und zur Basis zurückkehren, damit der
 * nächste Auftrag sauber startet; der nächste Versuch setzt den Branch fort.
 */
export async function finishOrderBranch(
  cwd: string,
  item: { id: string; title: string; kind?: string },
  target: OrderBranch,
  sprintName: string,
  passed: boolean,
  rawExecute: CommandExecutor = runCommand,
  hold?: (files: string[]) => boolean,
): Promise<{ merged: boolean; held?: boolean; commit: string | null; message: string }> {
  const execute: CommandExecutor = (command, directory, options) =>
    withProjectLock(cwd, () => rawExecute(command, directory, options));
  const { git, must } = gitHelpers(execute, cwd);
  // Hat jemand (Agent, Assistent, Mensch) den Branch gewechselt, wird nichts committet: die Änderungen gehören dann
  // nicht sicher zu diesem Auftrag, und ein Commit landete auf dem falschen Branch.
  const head = await currentBranch(git);
  if (head !== target.branch) {
    return {
      merged: false,
      commit: null,
      message: `Arbeitsordner steht auf ${head} statt auf ${target.branch} – nichts committet und nichts gemergt.`,
    };
  }
  // Patch des Arbeitsstands vor einem verworfenen Merge (siehe unten).
  let backup: string | null = null;
  try {
    // Konflikte nicht gelöst: offenen Merge verwerfen, damit kein Konfliktmarker committet wird und der nächste
    // Auftrag auf einem sauberen Stand beginnt (der Branch behält seine bisherigen Commits). Was der Agent bis dahin
    // gelöst oder geändert hat, bleibt als Patch erhalten.
    if ((await unresolvedConflicts(cwd, execute)).length) {
      backup = await backupWorkingTree(git, cwd, `merge-abbruch-${item.id.slice(0, 8)}`).catch(() => null);
      if (backup) console.warn(`Offener Merge von ${target.branch} verworfen, Arbeitsstand gesichert in ${backup}`);
      await git('merge', '--abort');
    }
    // Wie bei allen Auftrags-Commits: Dateien, die nach Zugangsdaten aussehen, bleiben außen vor.
    await stageAll(git, must, undefined, { orderOnly: true });
    const dirty = Boolean(await must('diff', '--cached', '--name-only'));
    if (passed) {
      if (dirty) {
        const [subject, body] = taskCommitMessage(item.kind, sprintName, item.title, item.id);
        await must('commit', '--no-verify', '-m', subject, '-m', body);
      }
      // Review-Freigabe: Branch bleibt bestehen und wird erst nach der Freigabe gemergt (mergeApprovedBranch).
      if (hold) {
        const changed = await git('diff', '--name-only', `${target.base}...${target.branch}`);
        if (hold(changed.exitCode === 0 ? changed.output.split('\n').filter(Boolean) : [])) {
          await leaveOrderBranch({ git, must }, target.base, cwd);
          return {
            merged: false,
            held: true,
            commit: null,
            message: `Wartet auf Freigabe – ${target.branch} wird danach in ${target.base} gemergt.`,
          };
        }
      }
      const mergeMessage = `Merge ${target.branch}: ${item.title.slice(0, 72)}`;
      // Basis im Ordner eines anderen Worktrees ausgecheckt (losgelöster Agent-Worktree, main beim Menschen): dort mergen.
      const elsewhere = await checkedOutElsewhere(git, target.base, cwd);
      if (elsewhere) {
        return await mergeIntoOtherWorktree({ git, must }, rawExecute, elsewhere, target, mergeMessage);
      }
      await must('checkout', target.base);
      // Nie in einen losgelösten Stand oder den Auftrags-Branch selbst „mergen“ (No-op, der als Erfolg gälte).
      const head = await currentBranch(git);
      if (head !== target.base) {
        return {
          merged: false,
          commit: null,
          message: `Arbeitsordner steht nach dem Wechsel auf ${head} statt auf ${target.base} – ${target.branch} bleibt bestehen.`,
        };
      }
      const merged = await git('merge', '--no-ff', target.branch, '-m', mergeMessage);
      const patchNote = backup ? ` Ein offener Merge wurde vorher verworfen, Arbeitsstand als Patch in ${backup}.` : '';
      if (merged.exitCode !== 0) {
        // Nur echte Konflikte heissen „Merge-Konflikt“ (der Auftrag wird dann neu eingeplant und der Entwickler löst
        // sie). Andere Fehler (Sperre, Hook, Platte voll) dürfen keinen erfundenen Konflikt auslösen.
        const conflicts = await unresolvedConflicts(cwd, execute);
        await git('merge', '--abort');
        return {
          merged: false,
          commit: null,
          message: conflicts.length
            ? `Merge-Konflikt mit ${target.base} (${conflicts.slice(0, 5).join(', ')}) – Branch ${target.branch} bleibt bestehen.${patchNote}`
            : `Merge nach ${target.base} fehlgeschlagen: ${briefGitError(merged.output)} – Branch ${target.branch} bleibt bestehen.${patchNote}`,
        };
      }
      return {
        merged: true,
        commit: await must('rev-parse', '--short', 'HEAD'),
        message: `In ${target.base} gemergt.${await deleteOrderBranch(git, target.branch)}${patchNote}`,
      };
    }
    if (dirty) {
      await must(
        'commit',
        '--no-verify',
        '-m',
        `wip(${sprintName || 'auftrag'}): ${item.title.slice(0, 60)}`,
        '-m',
        `Auftrag: ${item.id}\nZwischenstand eines fehlgeschlagenen Versuchs.`,
      );
    }
    await leaveOrderBranch({ git, must }, target.base, cwd);
    // Nur melden, was wirklich gesichert ist: nach einem verworfenen Merge steckt der Stand oft nur im Patch.
    const saved = [
      dirty ? `Zwischenstand auf ${target.branch} gesichert.` : '',
      backup ? `Offener Merge verworfen, Arbeitsstand als Patch gesichert in ${backup}.` : '',
    ]
      .filter(Boolean)
      .join(' ');
    return { merged: false, commit: null, message: saved || 'Keine Änderungen zu sichern.' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Z. B. ein Commit-Hook lehnt ab: Gestagtes darf nicht liegen bleiben, sonst wandert es beim nächsten Checkout in
    // den Branch des nächsten Auftrags. Zwischenstand auf dem eigenen Branch sichern und zur Basis zurück.
    const rescued = await rescueOrderBranch({ git, must }, item, target, sprintName, cwd).catch(() => false);
    return { merged: false, commit: null, message: rescued ? `${message} (Zwischenstand gesichert)` : message };
  }
}

/** Nach einem Fehler beim Abschluss: offenen Stand als WIP auf dem Auftrags-Branch committen und zur Basis wechseln. */
async function rescueOrderBranch(
  { git, must }: GitHelpers,
  item: { id: string; title: string },
  target: OrderBranch,
  sprintName: string,
  cwd: string,
): Promise<boolean> {
  if ((await currentBranch(git)) !== target.branch) return false;
  if ((await git('rev-parse', '-q', '--verify', 'MERGE_HEAD')).exitCode === 0) await git('merge', '--abort');
  await stageAll(git, must, undefined, { orderOnly: true });
  if ((await git('diff', '--cached', '--name-only')).output) {
    const committed = await git(
      'commit',
      '--no-verify',
      '-m',
      `wip(${sprintName || 'auftrag'}): ${item.title.slice(0, 60)}`,
      '-m',
      `Auftrag: ${item.id}\nZwischenstand nach einem Fehler beim Abschluss.`,
    );
    if (committed.exitCode !== 0) return false;
  }
  return leaveOrderBranch({ git, must }, target.base, cwd).then(
    () => true,
    () => false,
  );
}

/**
 * Zurück zur Basis: Ist sie in einem anderen Worktree ausgecheckt (losgelöster Agent-Worktree), bleibt dieser Ordner
 * losgelöst auf ihrem Stand – ein Checkout des Branches selbst scheiterte dort.
 */
async function leaveOrderBranch({ git, must }: GitHelpers, base: string, cwd: string): Promise<void> {
  if (await checkedOutElsewhere(git, base, cwd)) await must('checkout', '--detach', base);
  else await must('checkout', base);
}

/** Löscht den gemergten Auftrags-Branch; scheitert das, steht es in der Meldung statt still unterzugehen. */
async function deleteOrderBranch(git: GitHelpers['git'], branch: string): Promise<string> {
  const deleted = await git('branch', '-d', branch);
  return deleted.exitCode === 0 ? '' : ` Branch ${branch} konnte nicht gelöscht werden: ${deleted.output.slice(-200)}`;
}

/**
 * Mergt den Auftrags-Branch in die Basis, die in einem anderen Worktree ausgecheckt ist (z. B. main im Ordner der
 * Menschen, der Agent arbeitet im losgelösten Worktree). Gemergt wird dort selbst, damit Index und Arbeitsordner zum
 * Branch passen – aber nur, wenn dort die Basis ausgecheckt ist und keine offenen Änderungen an versionierten Dateien
 * liegen; sonst bleibt der Auftrags-Branch ungemergt bestehen. Konflikte werden sofort zurückgenommen (`merge --abort`).
 */
async function mergeIntoOtherWorktree(
  own: GitHelpers,
  rawExecute: CommandExecutor,
  folder: string,
  target: OrderBranch,
  mergeMessage: string,
): Promise<{ merged: boolean; commit: string | null; message: string }> {
  const other = gitHelpers(
    (command, directory, options) => withProjectLock(folder, () => rawExecute(command, directory, options)),
    folder,
  );
  // Der Agent-Ordner verlässt den Auftrags-Branch (losgelöst auf der Basis), damit er danach gelöscht werden kann.
  await own.must('checkout', '--detach', target.base);
  const unmerged = (reason: string) => ({
    merged: false,
    commit: null,
    message: `${reason} – ${target.branch} bleibt bestehen; dort mit „git merge ${target.branch}“ übernehmen.`,
  });
  const head = await currentBranch(other.git);
  const status = await other.git('status', '--porcelain', '--untracked-files=no');
  if (head !== target.base || status.exitCode !== 0 || status.output) {
    return unmerged(`In ${folder} sind Änderungen offen oder nicht ${target.base} ausgecheckt`);
  }
  if (await other.git('rev-parse', '-q', '--verify', 'MERGE_HEAD').then((result) => result.exitCode === 0)) {
    return unmerged(`In ${folder} läuft ein Merge`);
  }
  const merged = await other.git('merge', '--no-ff', target.branch, '-m', mergeMessage);
  if (merged.exitCode !== 0) {
    await other.git('merge', '--abort');
    return unmerged(`Merge-Konflikt mit ${target.base} in ${folder}`);
  }
  // Nur als Erfolg melden, was nachweislich in der Basis steckt.
  const contained = await own.git('merge-base', '--is-ancestor', target.branch, target.base);
  if (contained.exitCode !== 0)
    return unmerged(`${target.branch} ist nach dem Merge nicht in ${target.base} enthalten`);
  // Der Agent-Ordner folgt der Basis (weiterhin losgelöst), damit der nächste Auftrag vom neuen Stand ausgeht.
  await own.git('checkout', '--detach', target.base);
  return {
    merged: true,
    commit: await other.must('rev-parse', '--short', 'HEAD'),
    message: `In ${target.base} (Ordner ${folder}) gemergt.${await deleteOrderBranch(own.git, target.branch)}`,
  };
}

/**
 * Commit nach jedem Agent: was der Agent im Arbeitsordner geändert hat, landet sofort als eigener Commit auf dem
 * Auftrags-Branch („Entwickler: Titel“, bei einem gescheiterten Schritt „wip(Tester): Titel“). Ohne Änderungen
 * passiert nichts. Liefert den Kurz-Hash oder null.
 */
export async function commitAgentStep(
  cwd: string,
  item: { id: string; title: string },
  agentName: string,
  sprintName: string | null,
  passed: boolean,
  rawExecute: CommandExecutor = runCommand,
  /** Auftrags-Branch: steht der Ordner woanders (Agent hat ausgecheckt), wird nicht committet. */
  branch?: string,
): Promise<string | null> {
  const execute: CommandExecutor = (command, directory, options) =>
    withProjectLock(cwd, () => rawExecute(command, directory, options));
  const { git, must } = gitHelpers(execute, cwd);
  if (!existsSync(join(cwd, '.git'))) return null;
  try {
    if (branch) {
      const head = await currentBranch(git);
      if (head !== branch) {
        console.error(`Kein Commit nach ${agentName}: Arbeitsordner steht auf ${head} statt auf ${branch}.`);
        return null;
      }
    }
    // Nie Konfliktmarker committen: Der offene Merge bleibt bestehen, bis ein Agent die Konflikte gelöst hat.
    const pending = await unresolvedConflicts(cwd, execute);
    if (pending.length) {
      console.error(`Kein Commit nach ${agentName}: Merge-Konflikte offen in ${pending.join(', ')}`);
      return null;
    }
    await stageAll(git, must, undefined, { orderOnly: true });
    if (!(await must('diff', '--cached', '--name-only'))) return null;
    const title = item.title.slice(0, 60);
    const subject = passed ? `${agentName}: ${title}` : `wip(${agentName}): ${title}`;
    const body = `Auftrag: ${item.id}${sprintName ? `\nSprint: ${sprintName}` : ''}\nCommit nach dem Agent „${agentName}“.`;
    await must('commit', '--no-verify', '-m', subject, '-m', body);
    return await must('rev-parse', '--short', 'HEAD');
  } catch (error) {
    console.error(`Commit nach ${agentName} fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/** Nach der Review-Freigabe: Auftrags-Branch in seine Basis (Sprint-Branch) mergen und löschen. */
export async function mergeApprovedBranch(
  cwd: string,
  item: { title: string },
  branch: string,
  base: string,
  rawExecute: CommandExecutor = runCommand,
): Promise<{ merged: boolean; message: string }> {
  const execute: CommandExecutor = (command, directory, options) =>
    withProjectLock(cwd, () => rawExecute(command, directory, options));
  const { git, must } = gitHelpers(execute, cwd);
  try {
    if (!(await branchExists(git, branch))) return { merged: false, message: `Branch ${branch} gibt es nicht mehr.` };
    if (!(await branchExists(git, base))) return { merged: false, message: `Basis-Branch ${base} gibt es nicht mehr.` };
    const open = await trackedChanges(git);
    if (open.length)
      return {
        merged: false,
        message: `Offene Änderungen im Arbeitsordner (${open.slice(0, 5).join(', ')}) – ${branch} nicht gemergt.`,
      };
    if ((await git('rev-parse', '--abbrev-ref', 'HEAD')).output !== base) await must('checkout', base);
    const merged = await git('merge', '--no-ff', branch, '-m', `Merge ${branch}: ${item.title.slice(0, 72)}`);
    if (merged.exitCode !== 0) {
      await git('merge', '--abort');
      return { merged: false, message: `Merge-Konflikt mit ${base} – Branch ${branch} bleibt bestehen.` };
    }
    await git('branch', '-d', branch);
    return { merged: true, message: `Freigegeben und in ${base} gemergt.` };
  } catch (error) {
    return { merged: false, message: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Vorschau nachziehen: Arbeiten die Agents in einem eigenen Ordner, zeigt der Projektordner (z. B. mit laufendem
 * Entwicklungsserver) den Sprint-Stand. Nur wenn er losgelöst (detached) und ohne offene Änderungen ist – ein
 * ausgecheckter Branch oder eigene Arbeit eines Menschen bleibt unberührt. Liefert eine Meldung oder null.
 */
export async function followPreview(
  folder: string,
  base: string,
  execute: CommandExecutor = runCommand,
): Promise<string | null> {
  const { git } = gitHelpers(execute, folder);
  if (!existsSync(join(folder, '.git'))) return null;
  if ((await git('symbolic-ref', '-q', 'HEAD')).exitCode === 0) return null;
  if ((await git('status', '--porcelain', '--untracked-files=no')).output)
    return `Vorschau nicht nachgezogen: offene Änderungen in ${folder}.`;
  const moved = await git('checkout', '-q', '--detach', base);
  return moved.exitCode === 0
    ? `Vorschau in ${folder} auf ${base} nachgezogen.`
    : `Vorschau nicht nachgezogen: ${moved.output.slice(-200)}`;
}

/** Steht der Ordner auf einem Auftrags-Branch mit nicht committeten Änderungen? */
export async function orderWorkInProgress(cwd: string, rawExecute: CommandExecutor = runCommand): Promise<boolean> {
  if (!existsSync(join(cwd, '.git'))) return false;
  const { git } = gitHelpers(rawExecute, cwd);
  const branch = (await git('rev-parse', '--abbrev-ref', 'HEAD')).output.trim();
  if (!branch.startsWith('auftrag/')) return false;
  return Boolean((await git('status', '--porcelain', '--untracked-files=no')).output.trim());
}

export interface ChangedFile {
  path: string;
  /** Datei existiert im Arbeitsordner nicht mehr (vom Auftrag gelöscht). */
  deleted: boolean;
}

/**
 * Vom Auftrag geänderte Dateien: Commits seit der Basis (`git diff <base>...HEAD`) plus noch nicht committete und
 * neue Dateien im Arbeitsordner. Sortiert, ohne Doppelte, ohne interne Ordner; gelöschte Dateien sind markiert.
 */
export async function changedFiles(
  cwd: string,
  base: string,
  rawExecute: CommandExecutor = runCommand,
): Promise<ChangedFile[]> {
  if (!existsSync(join(cwd, '.git'))) return [];
  const { git } = gitHelpers(rawExecute, cwd);
  const list = async (...args: string[]): Promise<string[]> => {
    const result = await git('-c', 'core.quotePath=false', ...args);
    return result.exitCode === 0 ? result.output.split('\n').map((line) => line.trim()) : [];
  };
  const paths = new Set(
    [
      ...(await list('diff', '--name-only', `${base}...HEAD`)),
      ...(await list('diff', '--name-only', 'HEAD')),
      ...(await list('diff', '--name-only', '--cached')),
      ...(await list('ls-files', '--others', '--exclude-standard')),
    ].filter((path) => path && !CHANGED_FILES_IGNORED.some((prefix) => path.startsWith(prefix))),
  );
  return [...paths].sort().map((path) => ({ path, deleted: !existsSync(join(cwd, path)) }));
}

/** Abschnitt „## Geänderte Dateien“ für die Ausgabe eines Agent-Schritts. */
export function changedFilesSection(files: ChangedFile[]): string {
  const lines = files.map((file) => `- ${file.path}${file.deleted ? ' (gelöscht)' : ''}`);
  return `## Geänderte Dateien\n${lines.length ? lines.join('\n') : 'Keine Dateien geändert.'}`;
}
