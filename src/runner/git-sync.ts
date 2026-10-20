import { existsSync, realpathSync } from 'node:fs';
import { appendFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import type { Pool } from 'pg';
import { acquireTree, withProjectLock } from '../core/project-lock.js';
import { type CommandExecutor, redactOutput, runCommand } from '../core/command.js';
import { createGithubAdapter, githubRepo } from './github.js';
import type { CiStatus, HosterAdapter } from './hoster.js';
import { SECRET_PATTERNS } from '../core/secret-mask.js';
import { loadTestCommands } from './runner-selection.js';
import { requestRestart } from './system-restart.js';
import { BACKUP_DIRECTORY } from '../agent/tool-paths.js';
import { gitEnvironment, runProjectCommand } from './project-command.js';

const GIT_TIMEOUT_MS = 120_000;
const REMOTE_PATTERN = /^(https:\/\/[^\s@/]+\/[^\s]+|git@[A-Za-z0-9.-]+:[^\s]+|ssh:\/\/git@[^\s]+)$/;

export function isValidGitRemote(value: string): boolean {
  return value.length <= 300 && REMOTE_PATTERN.test(value);
}

/** Der Worker läuft ohne Terminal und Zugangsdaten-Dialog: GitHub-HTTPS-Adressen werden über SSH (Schlüssel) gepusht. */
export function pushRemote(remote: string): string {
  const match = remote.match(/^https:\/\/github\.com\/([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/);
  return match ? `git@github.com:${match[1]}.git` : remote;
}

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/\p{M}/gu, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'ohne-name'
  );
}

export function sprintTag(name: string, id: string): string {
  return `sprint-${slugify(name)}-${id.slice(0, 6)}`;
}

/** Branch, auf dem alle Aufträge eines Sprints committet werden; am Sprintende wird er nach main gemergt. */
export function sprintBranch(name: string): string {
  return `sprint/${slugify(name)}`;
}

const MAIN_BRANCH = 'main';
// Projekttests können den kompletten Oberflächentest mit Playwright enthalten (Desktop und Handy).
const TEST_TIMEOUT_MS = 45 * 60_000;

const INTERNAL_EXCLUDES = [
  '.dev-log-backups/',
  '.dev-log/',
  '.env',
  '.env.*',
  // Typische Zugangsdaten: gelten nur für noch nicht versionierte Dateien, bereits versionierte bleiben unberührt.
  '*.pem',
  '*.key',
  '*.p12',
  '*.pfx',
  'id_rsa*',
  'id_ed25519*',
  'id_ecdsa*',
  '.netrc',
  '.pgpass',
  'credentials.json',
  '*service-account*.json',
];

/** Inhalte, die nach Zugangsdaten aussehen (private Schlüssel, Cloud- und Git-Tokens); gemeinsam mit der Maskierung. */
const SECRET_CONTENT = SECRET_PATTERNS;

/** Dateien, deren hinzugefügte Zeilen im Diff nach Zugangsdaten aussehen. */
export function filesWithSecrets(diff: string): string[] {
  const found = new Set<string>();
  let file: string | null = null;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      file = line.startsWith('+++ b/') ? line.slice(6) : null;
    } else if (file && line.startsWith('+') && SECRET_CONTENT.some((pattern) => pattern.test(line))) {
      found.add(file);
    }
  }
  return [...found];
}

/**
 * Hält Agent-Sicherungen, Anhänge und .env-Dateien aus dem automatischen Commit heraus (lokal, ohne .gitignore zu
 * ändern). In einem Worktree ist `.git` eine Datei: die Liste gehört ins gemeinsame Git-Verzeichnis.
 */
async function excludeInternalFolders(git: GitHelpers['git'], cwd: string): Promise<void> {
  const common = await git('rev-parse', '--git-common-dir');
  if (common.exitCode !== 0 || !common.output) return;
  const file = join(isAbsolute(common.output) ? common.output : join(cwd, common.output), 'info', 'exclude');
  try {
    const current = await readFile(file, 'utf8').catch(() => '');
    const missing = INTERNAL_EXCLUDES.filter((entry) => !current.split(/\r?\n/).includes(entry));
    if (!missing.length) return;
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, `${current && !current.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n`);
  } catch {
    // Ohne Schreibzugriff bleibt das Verhalten wie bisher.
  }
}

/**
 * Identität aller Commits und Merges von AIdeation. Gesetzt pro Befehl statt in der Repo-Konfiguration: die gilt für
 * alle Worktrees, sonst trügen auch die Commits der Menschen im Projektordner den Namen des Bots (und umgekehrt).
 */
export const BOT_IDENTITY = {
  GIT_AUTHOR_NAME: 'AIdeation',
  GIT_AUTHOR_EMAIL: 'dev-log@mainty.local',
  GIT_COMMITTER_NAME: 'AIdeation',
  GIT_COMMITTER_EMAIL: 'dev-log@mainty.local',
};

function gitHelpers(execute: CommandExecutor, cwd: string) {
  // Gefiltert und ohne Hooks: Agents können im Projekt Hooks oder fsmonitor setzen, die sonst beim Commit liefen.
  const env = gitEnvironment({
    ...BOT_IDENTITY,
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new',
  });
  const git = async (...args: string[]) => {
    const result = await execute(['git', ...args], cwd, { timeoutMs: GIT_TIMEOUT_MS, env });
    return { ...result, output: redactOutput(result.output, process.env).trim() };
  };
  const must = async (...args: string[]): Promise<string> => {
    const result = await git(...args);
    if (result.exitCode !== 0) {
      throw new Error(`git ${args[0]} fehlgeschlagen: ${result.output.slice(-500)}`);
    }
    return result.output;
  };
  return { git, must };
}

type GitHelpers = ReturnType<typeof gitHelpers>;

/**
 * „git add -A“ mit Schutz: Dateien, die nach Zugangsdaten aussehen, werden wieder aus dem Index genommen
 * (sie bleiben im Arbeitsverzeichnis) und gemeldet. Gibt die zurückgehaltenen Dateien zurück.
 */
async function stageAll(
  git: GitHelpers['git'],
  must: GitHelpers['must'],
  log?: string[],
  options: { orderOnly?: boolean } = {},
): Promise<string[]> {
  // Auftrags-Commits: Testberichte und Agent-Ablage gehören nicht zum Auftrag (sie kommen mit der Sprint-Sicherung).
  // Nur Pfade ausschliessen, die Git nicht ohnehin ignoriert: Ein ignorierter Pfad im Pathspec (z. B. .dev-log/ aus
  // info/exclude) lässt „git add“ mit Exit 1 abbrechen – der Stand bliebe dann gestagt liegen und blockierte jeden
  // weiteren Auftrag als „fremde Änderung“.
  const excluded: string[] = [];
  for (const path of options.orderOnly ? CHANGED_FILES_IGNORED : []) {
    if ((await git('check-ignore', '-q', '--no-index', path)).exitCode !== 0) excluded.push(`:(exclude)${path}`);
  }
  await must('add', '-A', ...(options.orderOnly ? ['--', '.', ...excluded] : []));
  const diff = await git('diff', '--cached', '--no-color', '--no-ext-diff', '-U0');
  const held = diff.exitCode === 0 ? filesWithSecrets(diff.output) : [];
  if (!held.length) return held;
  const hasHead = (await git('rev-parse', '--verify', '--quiet', 'HEAD')).exitCode === 0;
  await must(...(hasHead ? ['reset', '-q', '--'] : ['rm', '--cached', '-q', '--']), ...held);
  const message = `Nicht committet, weil sie nach Zugangsdaten aussehen: ${held.join(', ')}`;
  if (log) log.push(message);
  else console.warn(message);
  return held;
}

/** Initialisiert das Repository bei Bedarf und schließt interne Ordner aus (Identität: BOT_IDENTITY). Gibt zurück, ob neu initialisiert wurde. */
async function ensureRepository(git: GitHelpers['git'], must: GitHelpers['must'], cwd: string): Promise<boolean> {
  let initialized = false;
  if (!existsSync(join(cwd, '.git'))) {
    await must('init', '-b', 'main');
    initialized = true;
  }
  await excludeInternalFolders(git, cwd);
  return initialized;
}

/** Aktueller Branch; „HEAD“ bei losgelöstem Stand. Funktioniert auch in einem Repository ohne Commit. */
async function currentBranch(git: GitHelpers['git']): Promise<string> {
  const ref = await git('symbolic-ref', '--short', '-q', 'HEAD');
  return ref.exitCode === 0 && ref.output ? ref.output : 'HEAD';
}

/**
 * Sichert einen Arbeitsstand als Patch unter .dev-log-backups, bevor git ihn verwirft (z. B. `merge --abort`).
 * Liefert den Pfad oder null, wenn nichts zu sichern war.
 */
async function backupWorkingTree(git: GitHelpers['git'], cwd: string, label: string): Promise<string | null> {
  const diff = await git('diff', '--no-color', '--no-ext-diff', '--binary', 'HEAD');
  if (diff.exitCode !== 0 || !diff.output) return null;
  const file = join(cwd, BACKUP_DIRECTORY, `${label}-${new Date().toISOString().replace(/[:.]/g, '-')}.patch`);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${diff.output}\n`);
  return file;
}

/** Ordner eines anderen Worktrees, in dem der Branch ausgecheckt ist (sonst null). */
export async function checkedOutElsewhere(git: GitHelpers['git'], branch: string, cwd: string): Promise<string | null> {
  const listing = await git('worktree', 'list', '--porcelain');
  if (listing.exitCode !== 0) return null;
  const real = (path: string): string => (existsSync(path) ? realpathSync(path) : path);
  const own = real(cwd);
  for (const block of listing.output.split(/\n\s*\n/)) {
    const path = /^worktree (.+)$/m.exec(block)?.[1];
    const lines = block.split('\n');
    if (path && lines.includes(`branch refs/heads/${branch}`) && real(path) !== own) return path;
  }
  return null;
}

async function branchExists(git: GitHelpers['git'], branch: string): Promise<boolean> {
  return (await git('rev-parse', '--verify', '--quiet', `refs/heads/${branch}`)).exitCode === 0;
}

/**
 * Wechselt vor der Arbeit an einem Sprint-Auftrag auf den Sprint-Branch (legt ihn bei Bedarf von main an).
 * Ungespeicherte Änderungen wandern mit; scheitert der Wechsel, bleibt der aktuelle Branch und es wird geloggt.
 */
export async function checkoutSprintBranch(
  cwd: string,
  sprintName: string,
  rawExecute: CommandExecutor = runCommand,
): Promise<string | null> {
  const execute: CommandExecutor = (command, directory, options) =>
    withProjectLock(cwd, () => rawExecute(command, directory, options));
  const { git, must } = gitHelpers(execute, cwd);
  const branch = sprintBranch(sprintName);
  try {
    await ensureRepository(git, must, cwd);
    if ((await git('rev-parse', '--abbrev-ref', 'HEAD')).output === branch) return branch;
    if (await branchExists(git, branch)) await must('checkout', branch);
    else if (await branchExists(git, MAIN_BRANCH)) await must('checkout', '-b', branch, MAIN_BRANCH);
    else await must('checkout', '-b', branch);
    return branch;
  } catch (error) {
    console.error(`Sprint-Branch ${branch} nicht aktiv: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

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
    .map((line) => line.slice(3).trim())
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
      if (merged.exitCode !== 0) {
        await git('merge', '--abort');
        return {
          merged: false,
          commit: null,
          message: `Merge-Konflikt mit ${target.base} – Branch ${target.branch} bleibt bestehen.`,
        };
      }
      return {
        merged: true,
        commit: await must('rev-parse', '--short', 'HEAD'),
        message: `In ${target.base} gemergt.${await deleteOrderBranch(git, target.branch)}`,
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
    if ((await git('status', '--porcelain', '--untracked-files=no')).output)
      return { merged: false, message: `Offene Änderungen im Arbeitsordner – ${branch} nicht gemergt.` };
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

const CI_WORKFLOW = join('.github', 'workflows', 'devlog-ci.yml');
const CI_WAIT_MS = 30 * 60_000;

const shellArg = (part: string): string => (/^[\w@%+=:,./-]+$/.test(part) ? part : `'${part.replace(/'/g, `'\\''`)}'`);

/** GitHub-Actions-Workflow: dieselben Testbefehle wie das lokale Test-Gate, bei Push und Pull Request. */
export function ciWorkflowYaml(
  commands: string[][],
  options: { node: boolean; lockfile: boolean; python: boolean },
): string {
  const steps = [
    '      - uses: actions/checkout@v4',
    ...(options.node
      ? [
          '      - uses: actions/setup-node@v4',
          '        with:',
          "          node-version-file: '.nvmrc'",
          ...(options.lockfile ? ["          cache: 'npm'"] : []),
          `      - run: ${options.lockfile ? 'npm ci' : 'npm install'}`,
        ]
      : []),
    ...(options.python
      ? [
          '      - uses: actions/setup-python@v5',
          '        with:',
          "          python-version: '3.12'",
          '      - run: pip install -r requirements.txt',
        ]
      : []),
    ...commands.map((command) => `      - run: ${command.map(shellArg).join(' ')}`),
  ];
  return `# Automatisch von AIdeation angelegt: Build und Tests als Quality Gate für Pull Requests und main.
name: CI
on:
  push:
    branches: [main, 'sprint/**']
  pull_request:
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
${steps.join('\n')}
`;
}

/** Legt den CI-Workflow an, falls das Projekt nach GitHub pusht und noch keinen Workflow hat. */
async function ensureCiWorkflow(cwd: string, commands: string[][], helpers: GitHelpers, log: string[]): Promise<void> {
  const directory = join(cwd, '.github', 'workflows');
  const existing = existsSync(directory) ? (await readdir(directory)).filter((file) => /\.ya?ml$/.test(file)) : [];
  if (existing.length || !commands.length) return;
  const node = existsSync(join(cwd, 'package.json'));
  if (node && !existsSync(join(cwd, '.nvmrc'))) await writeFile(join(cwd, '.nvmrc'), '22\n');
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(cwd, CI_WORKFLOW),
    ciWorkflowYaml(commands, {
      node,
      lockfile: existsSync(join(cwd, 'package-lock.json')),
      python: existsSync(join(cwd, 'requirements.txt')),
    }),
  );
  await helpers.must('add', CI_WORKFLOW, ...(node ? ['.nvmrc'] : []));
  await helpers.must(
    'commit',
    '--no-verify',
    '-m',
    'ci: GitHub-Actions-Workflow für Build und Tests',
    '-m',
    'Automatisch angelegt vom AIdeation.',
  );
  log.push('CI-Workflow (GitHub Actions) angelegt.');
}

/** Status und Ergebnis eines GitHub-Actions-Laufs aus `gh run view --json status,conclusion`. */
export function parseRunState(output: string): { status: string; conclusion: string } | null {
  const json = /\{[^{}]*\}/.exec(output);
  if (!json) return null;
  try {
    const value = JSON.parse(json[0]) as { status?: unknown; conclusion?: unknown };
    return typeof value.status === 'string'
      ? { status: value.status, conclusion: typeof value.conclusion === 'string' ? value.conclusion : '' }
      : null;
  } catch {
    return null;
  }
}

/**
 * Wartet auf den GitHub-Actions-Lauf für den gepushten Stand (über die gh CLI). Ohne gh bleibt das lokale Test-Gate
 * maßgeblich; ein roter CI-Lauf verhindert den Merge nach main. Das Urteil kommt aus dem Lauf selbst: `gh run watch`
 * endet bei Netz- oder API-Fehlern auch vorzeitig mit Fehlercode, während der Lauf noch läuft.
 */
export async function waitForCi(
  execute: CommandExecutor,
  cwd: string,
  branch: string,
  log: string[],
  pollMs = 10_000,
): Promise<void> {
  const env = gitEnvironment({ GH_PROMPT_DISABLED: '1' });
  const gh = async (timeoutMs: number, ...args: string[]) => execute(['gh', ...args], cwd, { timeoutMs, env });
  const auth = await gh(GIT_TIMEOUT_MS, 'auth', 'status', '--hostname', 'github.com').catch(() => null);
  if (!auth || auth.exitCode !== 0) {
    log.push('CI-Status nicht prüfbar (GitHub CLI fehlt oder ist nicht angemeldet) – das lokale Test-Gate gilt.');
    return;
  }
  const sha = (await execute(['git', 'rev-parse', 'HEAD'], cwd, { timeoutMs: GIT_TIMEOUT_MS, env })).output.trim();
  let runId = '';
  for (let attempt = 0; attempt < 24 && !runId; attempt += 1) {
    const list = await gh(
      GIT_TIMEOUT_MS,
      'run',
      'list',
      '--branch',
      branch,
      '--commit',
      sha,
      '--limit',
      '1',
      '--json',
      'databaseId',
      '--jq',
      '.[0].databaseId',
    );
    runId = list.exitCode === 0 ? list.output.trim() : '';
    if (!runId) await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  if (!runId) {
    log.push('Kein CI-Lauf gefunden (Workflow fehlt oder GitHub Actions ist aus) – das lokale Test-Gate gilt.');
    return;
  }
  const deadline = Date.now() + CI_WAIT_MS;
  let state: { status: string; conclusion: string } | null;
  let watched = '';
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining > 0) watched = (await gh(remaining, 'run', 'watch', runId)).output;
    state = parseRunState((await gh(GIT_TIMEOUT_MS, 'run', 'view', runId, '--json', 'status,conclusion')).output);
    if (state?.status === 'completed' || Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  if (state?.status !== 'completed') {
    throw new Error(
      `Merge nach main zurückgestellt: CI-Lauf ${runId} auf ${branch} ist nach ${CI_WAIT_MS / 60_000} Minuten noch nicht fertig (Status: ${state?.status ?? 'unbekannt'}).`,
    );
  }
  if (state.conclusion !== 'success') {
    throw new Error(
      `Merge nach main abgelehnt: CI-Lauf ${runId} auf ${branch} ist rot (${state.conclusion || 'ohne Ergebnis'}). ${redactOutput(watched, process.env).slice(-400)}`,
    );
  }
  log.push(`CI grün (Lauf ${runId}).`);
}

/** Führt die Testbefehle des Projekts aus; wirft mit dem Ausgabe-Ende, sobald einer fehlschlägt. */
async function runTestGate(execute: CommandExecutor, cwd: string, commands: string[][], log: string[]): Promise<void> {
  for (const command of commands) {
    // Nur mit dem gefilterten Environment: Projekttests sollen weder AIdeation-Zugänge sehen noch vom Projektbereich
    // des Workers abhängen.
    const result = await runProjectCommand(command, cwd, { timeoutMs: TEST_TIMEOUT_MS }, execute);
    if (result.exitCode !== 0) {
      throw new Error(
        `Push abgelehnt: \`${command.join(' ')}\` ist fehlgeschlagen (Exit-Code ${result.exitCode}). ${redactOutput(result.output, process.env).slice(-600)}`,
      );
    }
  }
  log.push(
    commands.length
      ? `Tests grün (${commands.length} Befehl${commands.length === 1 ? '' : 'e'}).`
      : 'Keine Testbefehle hinterlegt.',
  );
}

/** Conventional-Commits-Betreff: Typ aus der Auftragsart, Sprint als Scope, Titel auf eine Zeile gekürzt. */
export function taskCommitMessage(
  kind: string | undefined,
  sprintName: string,
  title: string,
  itemId: string,
): [string, string] {
  const type = kind === 'bug' ? 'fix' : 'feat';
  const scope =
    sprintName
      .replace(/[()\r\n:]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 40) || 'sprint';
  const subject = title.replace(/\s+/g, ' ').trim().slice(0, 72) || 'Auftrag';
  return [
    `${type}(${scope}): ${subject}`,
    `Auftrag: ${itemId}\nSprint: ${sprintName}\nAutomatisch erstellt vom AIdeation.`,
  ];
}

/** Erstellt nach einem erledigten Sprint-Auftrag einen lokalen Commit (kein Push; den übernimmt die Sprint-Sicherung). */
export async function commitTaskToGit(
  cwd: string,
  item: { id: string; title: string; kind?: string },
  sprintName: string,
  rawExecute: CommandExecutor = runCommand,
): Promise<string | null> {
  const execute: CommandExecutor = (command, directory, options) =>
    withProjectLock(cwd, () => rawExecute(command, directory, options));
  const { git, must } = gitHelpers(execute, cwd);
  try {
    await ensureRepository(git, must, cwd);
    await stageAll(git, must);
    if (!(await must('diff', '--cached', '--name-only'))) return null;
    const [subject, body] = taskCommitMessage(item.kind, sprintName, item.title, item.id);
    await must('commit', '--no-verify', '-m', subject, '-m', body);
    return await must('rev-parse', '--short', 'HEAD');
  } catch (error) {
    console.error(
      `Auftrags-Commit für ${item.id} fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

/**
 * Erst-Commit beim Verbinden eines Projekts: Repository bei Bedarf anlegen, interne Ordner und .env ausschliessen und
 * Dateien, die nach Zugangsdaten aussehen, zurückhalten – bevor irgendetwas gepusht wird.
 */
export async function commitProjectSetup(
  cwd: string,
  rawExecute: CommandExecutor = runCommand,
): Promise<{ initialized: boolean; committed: boolean; held: string[] }> {
  const { git, must } = gitHelpers(rawExecute, cwd);
  const initialized = await ensureRepository(git, must, cwd);
  const hasCommit = (await git('rev-parse', '--verify', '--quiet', 'HEAD')).exitCode === 0;
  const log: string[] = [];
  const held = await stageAll(git, must, log);
  const staged = Boolean(await must('diff', '--cached', '--name-only'));
  if (!staged && hasCommit) return { initialized, committed: false, held };
  await must(
    'commit',
    '--no-verify',
    '--allow-empty',
    '-m',
    hasCommit ? 'chore: Projekt mit AIdeation verbunden' : 'chore: Initial-Commit',
  );
  return { initialized, committed: true, held };
}

interface PendingSprint {
  id: string;
  name: string;
  action: 'push' | 'pull' | null;
  remote: string | null;
  status: string;
  prUrl?: string | null;
}

/** PR-Modus beim Sprint-Abschluss: Adapter des Hosters, Sprintbericht als Text und ein schon offener Pull Request. */
interface PullRequestPlan {
  adapter: HosterAdapter;
  body: string;
  existing: string | null;
}

async function configureOrigin(git: GitHelpers['git'], must: GitHelpers['must'], remote: string): Promise<void> {
  const current = await git('remote', 'get-url', 'origin');
  const target = pushRemote(remote);
  await must(
    ...(current.exitCode === 0 ? ['remote', 'set-url', 'origin', target] : ['remote', 'add', 'origin', target]),
  );
}

interface SyncResult {
  commit: string;
  branch: string;
  log: string[];
  /** Der Sprint wurde in diesem Lauf nach main gemergt. */
  mergedMain?: boolean;
  /** PR-Modus: Link des geöffneten Pull Requests; Merge und Tag folgen nach grüner CI. */
  pullRequest?: string;
}

/**
 * Sichert den Sprint-Branch: Reständerungen committen, Projekttests ausführen (Test-Gate) und nur bei grünen Tests pushen.
 * Ist der Sprint abgeschlossen, wird der Sprint-Branch danach mit --no-ff nach main gemergt, erneut getestet und gepusht.
 */
async function pushSprint(
  helpers: GitHelpers,
  sprint: PendingSprint,
  log: string[],
  gate: (log: string[]) => Promise<void>,
  ci: {
    cwd: string;
    commands: string[][];
    execute: CommandExecutor;
    mergeElsewhere?: boolean;
    pullRequest?: PullRequestPlan | null;
  },
): Promise<SyncResult> {
  const { git, must } = helpers;
  const branch = sprintBranch(sprint.name);
  let mergedMain = false;
  if (await branchExists(git, branch)) {
    if ((await must('rev-parse', '--abbrev-ref', 'HEAD')) !== branch) await must('checkout', branch);
  } else {
    log.push(`Kein Sprint-Branch ${branch} – sichere den aktuellen Branch.`);
  }
  await stageAll(git, must, log);
  if (await must('diff', '--cached', '--name-only')) {
    await must(
      'commit',
      '--no-verify',
      '-m',
      `chore(${sprint.name}): Sprint-Stand sichern`,
      '-m',
      'Automatisch gesichert vom AIdeation.',
    );
    log.push('Reständerungen committet.');
  }
  // Geprüft wird der Stand, der live geht: aktuellen main in den Sprint-Branch übernehmen (z. B. Korrekturen, die
  // nach dem Sprintstart auf main kamen). Konflikte brechen ab, statt etwas Ungeprüftes zu mergen.
  if (sprint.status === 'completed' && (await branchExists(git, MAIN_BRANCH))) {
    const head = await must('rev-parse', '--abbrev-ref', 'HEAD');
    if (head !== MAIN_BRANCH && (await git('merge-base', '--is-ancestor', MAIN_BRANCH, 'HEAD')).exitCode !== 0) {
      const merged = await git('merge', '--no-edit', MAIN_BRANCH, '-m', `Merge ${MAIN_BRANCH} in ${head}`);
      if (merged.exitCode !== 0) {
        await git('merge', '--abort');
        throw new Error(
          `${MAIN_BRANCH} lässt sich nicht konfliktfrei in ${head} übernehmen – bitte zusammenführen. ${merged.output.slice(-300)}`,
        );
      }
      log.push(`Aktuellen ${MAIN_BRANCH} in ${head} übernommen.`);
    }
  }
  if (sprint.remote && /github\.com/.test(sprint.remote)) await ensureCiWorkflow(ci.cwd, ci.commands, helpers, log);
  await gate(log);
  let current = await must('rev-parse', '--abbrev-ref', 'HEAD');
  if (sprint.remote) {
    await must('push', '-u', 'origin', current);
    log.push(`${current} nach GitHub gepusht.`);
  }
  if (sprint.status === 'review') {
    // Nachbesserung im Review: der Push aktualisiert den Pull Request; der Tag folgt erst nach dem Merge.
    log.push('Sprint im Review: Pull Request aktualisiert, Merge und Tag folgen nach grüner CI.');
    return { commit: await must('rev-parse', '--short', 'HEAD'), branch: current, log };
  }
  if (sprint.status === 'completed' && current === branch && ci.pullRequest && sprint.remote) {
    // PR-Modus: statt direkt zu mergen einen Pull Request öffnen; den Merge übernimmt pollSprintReviews.
    const { adapter, body, existing } = ci.pullRequest;
    const url =
      existing ??
      (await adapter.findPullRequest(branch)) ??
      (await adapter.createPullRequest({ head: branch, base: MAIN_BRANCH, title: `Sprint: ${sprint.name}`, body }));
    log.push(`Pull Request ${url} geöffnet – Merge nach ${MAIN_BRANCH} und Tag folgen nach grüner CI.`);
    return { commit: await must('rev-parse', '--short', 'HEAD'), branch: current, log, pullRequest: url };
  }
  if (sprint.status === 'completed' && current === branch) {
    if (sprint.remote) await waitForCi(ci.execute, ci.cwd, branch, log);
    const elsewhere = await checkedOutElsewhere(git, MAIN_BRANCH, ci.cwd);
    if (elsewhere && ci.mergeElsewhere) {
      // „Nach dem Sprint neu starten“: main im Arbeitsordner der Menschen nur übernehmen, wenn dort nichts offen ist.
      mergedMain = await mergeIntoCheckedOutMain(ci.execute, elsewhere, branch, sprint.name, ci.commands, log);
      if (mergedMain && sprint.remote) {
        const pushed = await ci.execute(['git', 'push', '-u', 'origin', MAIN_BRANCH], elsewhere, {
          timeoutMs: 120_000,
          env: gitEnvironment({ GIT_TERMINAL_PROMPT: '0' }),
        });
        log.push(
          pushed.exitCode === 0 ? `${MAIN_BRANCH} nach GitHub gepusht.` : `Push von ${MAIN_BRANCH} fehlgeschlagen.`,
        );
      }
    } else if (elsewhere) {
      // Agents im eigenen Worktree: main gehört dem Arbeitsordner der Menschen und wird dort nicht angefasst.
      log.push(
        `Sprint abgeschlossen: ${branch} ist bereit. ${MAIN_BRANCH} ist in ${elsewhere} ausgecheckt – dort mit „git merge ${branch}“ übernehmen.`,
      );
    } else if (await branchExists(git, MAIN_BRANCH)) {
      await must('checkout', MAIN_BRANCH);
      const before = await must('rev-parse', 'HEAD');
      const merged = await git('merge', '--no-ff', branch, '-m', `Merge ${branch}: Sprint ${sprint.name}`);
      if (merged.exitCode !== 0) {
        await git('merge', '--abort');
        await must('checkout', branch);
        throw new Error(
          `Merge von ${branch} nach ${MAIN_BRANCH} hat Konflikte – bitte manuell zusammenführen. ${merged.output.slice(-300)}`,
        );
      }
      try {
        await gate(log);
      } catch (error) {
        // Rotes Test-Gate: main nicht mit dem ungeprüften Merge stehen lassen (neue Sprints zweigen von main ab).
        const reset = await git('reset', '--keep', before);
        if (reset.exitCode === 0) await git('checkout', branch);
        throw new Error(
          `${error instanceof Error ? error.message : String(error)} ${
            reset.exitCode === 0
              ? `Merge nach ${MAIN_BRANCH} zurückgenommen.`
              : `ACHTUNG: Merge nach ${MAIN_BRANCH} konnte nicht zurückgenommen werden (${reset.output.slice(-200)}) – ${MAIN_BRANCH} von Hand auf ${before.slice(0, 7)} zurücksetzen.`
          }`,
          { cause: error },
        );
      }
    } else {
      await must('branch', '-m', branch, MAIN_BRANCH);
    }
    if (!elsewhere) {
      mergedMain = true;
      current = MAIN_BRANCH;
      log.push(`Sprint abgeschlossen: ${branch} nach ${MAIN_BRANCH} gemergt.`);
      if (sprint.remote) await must('push', '-u', 'origin', MAIN_BRANCH);
    }
  }
  const tag = sprintTag(sprint.name, sprint.id);
  await must('tag', '-f', tag);
  if (sprint.remote) {
    await must('push', '--force', 'origin', `refs/tags/${tag}`);
    log.push(`Tag ${tag} gepusht.`);
  } else {
    log.push('Kein GitHub-Repository am Projekt hinterlegt – nur lokal gesichert.');
  }
  return { commit: await must('rev-parse', '--short', 'HEAD'), branch: current, log, mergedMain };
}

/**
 * Übernimmt den Sprint in main, das in einem anderen Ordner (dem Arbeitsordner der Menschen) ausgecheckt ist. Nur
 * wenn dort keine offenen Änderungen liegen und main ausgecheckt ist; danach läuft das Test-Gate dort. Scheitert es,
 * wird der Merge mit `git reset --keep` zurückgenommen (verliert nie lokale Änderungen).
 */
export async function mergeIntoCheckedOutMain(
  execute: CommandExecutor,
  folder: string,
  branch: string,
  sprintName: string,
  commands: string[][],
  log: string[],
): Promise<boolean> {
  const git = (...args: string[]) =>
    execute(['git', ...args], folder, { timeoutMs: 120_000, env: gitEnvironment(BOT_IDENTITY) });
  const head = await git('rev-parse', '--abbrev-ref', 'HEAD');
  const status = await git('status', '--porcelain', '--untracked-files=no');
  if (head.exitCode !== 0 || head.output.trim() !== MAIN_BRANCH || status.exitCode !== 0 || status.output.trim()) {
    log.push(
      `Sprint abgeschlossen: ${branch} ist bereit. In ${folder} sind Änderungen offen oder nicht ${MAIN_BRANCH} ausgecheckt – dort mit „git merge ${branch}“ übernehmen; kein automatischer Neustart.`,
    );
    return false;
  }
  const before = (await git('rev-parse', 'HEAD')).output.trim();
  const merged = await git('merge', '--no-ff', branch, '-m', `Merge ${branch}: Sprint ${sprintName}`);
  if (merged.exitCode !== 0) {
    await git('merge', '--abort');
    log.push(`Merge von ${branch} nach ${MAIN_BRANCH} in ${folder} hat Konflikte – bitte manuell zusammenführen.`);
    return false;
  }
  try {
    await runTestGate(execute, folder, commands, log);
  } catch (error) {
    // Auf den Stand vor dem Merge (nicht ORIG_HEAD: den können Befehle des Test-Gates verschoben haben).
    const reset = await git('reset', '--keep', before);
    const detail = error instanceof Error ? error.message : '';
    log.push(
      reset.exitCode === 0
        ? `Test-Gate nach dem Merge in ${folder} rot – Merge zurückgenommen. ${detail}`.trim()
        : `Test-Gate nach dem Merge in ${folder} rot – ACHTUNG: Merge konnte nicht zurückgenommen werden (${reset.output.trim().slice(-200)}); ${MAIN_BRANCH} dort von Hand auf ${before.slice(0, 7)} zurücksetzen. ${detail}`.trim(),
    );
    return false;
  }
  log.push(`Sprint abgeschlossen: ${branch} in ${folder} nach ${MAIN_BRANCH} gemergt.`);
  return true;
}

/** Holt den Stand von GitHub per Fast-Forward; lokale Änderungen oder abweichende Historie brechen mit Fehlermeldung ab. */
async function pullSprint(helpers: GitHelpers, sprint: PendingSprint, log: string[]): Promise<SyncResult> {
  const { must } = helpers;
  if (!sprint.remote) {
    throw new Error('Kein GitHub-Repository am Projekt hinterlegt.');
  }
  const branch = await must('rev-parse', '--abbrev-ref', 'HEAD');
  await must('pull', '--ff-only', 'origin', branch);
  log.push('Stand von GitHub geladen.');
  return { commit: await must('rev-parse', '--short', 'HEAD'), branch, log };
}

/** Steht der Ordner auf einem Auftrags-Branch mit nicht committeten Änderungen? */
export async function orderWorkInProgress(cwd: string, rawExecute: CommandExecutor = runCommand): Promise<boolean> {
  if (!existsSync(join(cwd, '.git'))) return false;
  const { git } = gitHelpers(rawExecute, cwd);
  const branch = (await git('rev-parse', '--abbrev-ref', 'HEAD')).output.trim();
  if (!branch.startsWith('auftrag/')) return false;
  return Boolean((await git('status', '--porcelain', '--untracked-files=no')).output.trim());
}

/** Interne Ordner, die nie als geänderte Datei eines Auftrags zählen (Agent-Ablage, Testberichte). */
const CHANGED_FILES_IGNORED = ['.dev-log/', 'docs/tests/'];

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

/**
 * Live schalten nach dem Merge nach main und das Ergebnis protokollieren. Erfolg nur, wenn der Deploy nicht
 * gescheitert ist (deployProject meldet das mit false statt zu werfen).
 */
async function goLiveLogged(onMergedMain: () => Promise<boolean | null | void>, log: string[]): Promise<void> {
  try {
    const deployed = await onMergedMain();
    log.push(
      deployed === false
        ? 'Live schalten unvollständig: Deploy fehlgeschlagen (Details im Deploy-Status des Projekts).'
        : deployed === null
          ? 'Live geschaltet: Projektordner auf main nachgezogen (keine Deploy-Befehle hinterlegt).'
          : 'Live geschaltet: Projektordner auf main nachgezogen und deployt.',
    );
  } catch (error) {
    log.push(`Live schalten unvollständig: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Works through the next queued Git request (push or pull) of the project's sprints. */
export async function syncSprintToGit(
  pool: Pool,
  project: string,
  cwd: string,
  rawExecute: CommandExecutor = runCommand,
  /** Nach dem Merge nach main („Live schalten“): Live-Ordner nachziehen und deployen (Ergebnis wie goLive). */
  onMergedMain?: () => Promise<boolean | null | void>,
): Promise<number> {
  const execute: CommandExecutor = (command, directory, options) =>
    withProjectLock(cwd, () => rawExecute(command, directory, options));
  await pool.query(
    `UPDATE sprints SET git_sync = 'pending' WHERE project_slug = $1 AND git_sync = 'running'
        AND updated_at < NOW() - INTERVAL '30 minutes'`,
    [project],
  );
  // Ein unterbrochener Auftrag (z. B. durch einen Neustart) steht noch mit offenen Änderungen auf seinem Branch und
  // läuft gleich weiter. Die Git-Sicherung wartet (bleibt „pending“), statt am Checkout zu scheitern; sie läuft am
  // Ende desselben Durchlaufs erneut.
  if (await orderWorkInProgress(cwd, execute)) return 0;
  const claimed = await pool.query<PendingSprint>(
    `UPDATE sprints s SET git_sync = 'running'
      WHERE s.id = (SELECT id FROM sprints WHERE project_slug = $1 AND git_sync = 'pending'
                     ORDER BY updated_at LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING s.id, s.name, s.status, s.git_action AS action, s.pr_url AS "prUrl",
                (SELECT git_remote FROM projects WHERE slug = s.project_slug) AS remote`,
    [project],
  );
  const sprint = claimed.rows[0];
  if (!sprint) {
    return 0;
  }
  const helpers = gitHelpers(execute, cwd);
  const log: string[] = [];
  // Checkout, „Sprint-Stand sichern“ und Merge exklusiv: kein Assistent schreibt dazwischen in den Ordner.
  const releaseTree = await acquireTree(cwd);
  try {
    if (await ensureRepository(helpers.git, helpers.must, cwd)) {
      log.push('Repository initialisiert.');
    }
    if (sprint.remote) {
      await configureOrigin(helpers.git, helpers.must, sprint.remote);
    }
    const commands = await loadTestCommands(pool, project);
    const restartAfterSprint =
      (
        await pool
          .query<{ restart: boolean }>('SELECT restart_after_sprint AS restart FROM projects WHERE slug = $1', [
            project,
          ])
          .catch(() => ({ rows: [] as { restart: boolean }[] }))
      ).rows[0]?.restart === true;
    const gate = (entries: string[]) => runTestGate(rawExecute, cwd, commands, entries);
    const pullRequest =
      sprint.action === 'pull' ? null : await planPullRequest(pool, project, sprint, cwd, rawExecute, log);
    const result =
      sprint.action === 'pull'
        ? await pullSprint(helpers, sprint, log)
        : await pushSprint(helpers, sprint, log, gate, {
            cwd,
            commands,
            execute: rawExecute,
            mergeElsewhere: restartAfterSprint,
            pullRequest,
          });
    if (result.pullRequest) {
      await pool.query(
        `UPDATE sprints SET status = 'review', pr_url = $5, ci_status = 'pending', ci_bug_run = NULL, git_sync = 'done',
                git_message = $2, git_commit = $3, git_branch = $4, git_synced_at = NOW() WHERE id = $1`,
        [sprint.id, result.log.join(' '), result.commit, result.branch, result.pullRequest],
      );
      return 1;
    }
    if (result.mergedMain && onMergedMain) await goLiveLogged(onMergedMain, result.log);
    if (result.mergedMain && restartAfterSprint) {
      const { created } = await requestRestart(
        pool,
        'Sprint-Abschluss',
        new Date(),
        `Automatisch nach dem Sprint „${sprint.name}“ (in main übernommen).`,
      );
      result.log.push(created ? 'Neustart von AIdeation angefordert.' : 'Ein Neustart läuft bereits.');
    }
    await pool.query(
      `UPDATE sprints SET git_sync = 'done', git_message = $2, git_commit = $3, git_branch = $4, git_synced_at = NOW() WHERE id = $1`,
      [sprint.id, result.log.join(' '), result.commit, result.branch],
    );
    return 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await pool.query(`UPDATE sprints SET git_sync = 'failed', git_message = $2, git_synced_at = NOW() WHERE id = $1`, [
      sprint.id,
      [...log, message].join(' ').slice(0, 1500),
    ]);
    console.error(`Git-Sicherung für Sprint ${sprint.id} fehlgeschlagen: ${message}`);
    return 0;
  } finally {
    releaseTree();
  }
}

/**
 * Entscheidet über den PR-Modus beim Sprint-Abschluss: nur bei `github_mode = 'issues+pr'`, GitHub-Remote und
 * angemeldeter gh CLI. Sonst null – dann läuft der Abschluss wie bisher (direkter Merge).
 */
async function planPullRequest(
  pool: Pool,
  project: string,
  sprint: PendingSprint,
  cwd: string,
  execute: CommandExecutor,
  log: string[],
): Promise<PullRequestPlan | null> {
  if (sprint.status !== 'completed') return null;
  const settings = (
    await pool
      .query<{ mode: string }>('SELECT github_mode AS mode FROM projects WHERE slug = $1', [project])
      .catch(() => ({ rows: [] as { mode: string }[] }))
  ).rows[0];
  const repo = githubRepo(sprint.remote);
  if (settings?.mode !== 'issues+pr' || !repo) return null;
  const adapter = createGithubAdapter(repo, execute, cwd);
  const auth = await adapter.authStatus();
  if (!auth.ok) {
    log.push(`PR-Modus übersprungen (${auth.message}) – Abschluss wie bisher.`);
    return null;
  }
  const report = (
    await pool.query<{ content: string }>(
      `SELECT content FROM docs WHERE project_slug = $1 AND kind = 'sprint' AND sprint_id = $2
        ORDER BY updated_at DESC LIMIT 1`,
      [project, sprint.id],
    )
  ).rows[0]?.content;
  return {
    adapter,
    body: `${report || `Sprint ${sprint.name}`}\n\n---\n_Automatisch geöffnet vom Mainty Dev Log._`,
    existing: sprint.prUrl ?? null,
  };
}

const CI_LOG_LINES = 60;
const CI_LOG_CHARS = 3_000;
const SECRET_ASSIGNMENT =
  /\b([A-Za-z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY|PRIVATE_KEY)[A-Za-z0-9_]*)(\s*[=:]\s*)("?)[^\s"']{4,}\3/gi;

/** Maskiert Zugangsdaten: Werte geheimer Umgebungsvariablen, bekannte Token-Formate und „TOKEN=…“-Zuweisungen. */
export function maskSecrets(text: string, environment: NodeJS.ProcessEnv = process.env): string {
  let masked = redactOutput(text, environment);
  for (const pattern of SECRET_CONTENT) {
    masked = masked.replace(new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`), '[REDACTED]');
  }
  return masked.replace(SECRET_ASSIGNMENT, '$1$2[REDACTED]');
}

/** Gekürzter, maskierter Auszug aus dem Log eines roten CI-Laufs: die letzten Zeilen, höchstens 3000 Zeichen. */
export function ciLogExcerpt(log: string, environment: NodeJS.ProcessEnv = process.env): string {
  const lines = maskSecrets(log, environment)
    .replace(/\r/g, '')
    .split('\n')
    .filter((line) => line.trim());
  const tail = lines.slice(-CI_LOG_LINES).join('\n');
  return tail.length > CI_LOG_CHARS ? `…${tail.slice(-CI_LOG_CHARS)}` : tail;
}

interface ReviewSprint {
  id: string;
  name: string;
  prUrl: string;
  ciStatus: CiStatus | null;
  ciBugRun: string | null;
}

/** Legt für einen roten CI-Lauf genau einen Bug an (der Lauf wird am Sprint vermerkt, bevor der Bug entsteht). */
async function reportCiFailure(
  pool: Pool,
  project: string,
  sprint: ReviewSprint,
  run: string,
  adapter: HosterAdapter,
): Promise<void> {
  const claimed = await pool.query(
    `UPDATE sprints SET ci_bug_run = $2 WHERE id = $1 AND ci_bug_run IS DISTINCT FROM $2 RETURNING id`,
    [sprint.id, run],
  );
  if (!claimed.rows[0]) return;
  const log = await adapter
    .failedRunLog(run)
    .catch((error: unknown) => `Log nicht abrufbar: ${error instanceof Error ? error.message : String(error)}`);
  const excerpt = ciLogExcerpt(log);
  await pool.query(
    `INSERT INTO bugs (project_slug, title, description, severity, source) VALUES ($1, $2, $3, 'high', 'github')`,
    [
      project,
      `CI rot im Pull Request von „${sprint.name}“`.slice(0, 180),
      [
        `Der CI-Lauf ${run} für den Pull Request ${sprint.prUrl} ist fehlgeschlagen. Der Sprint bleibt im Review und ` +
          `wird nicht gemergt; nach einem grünen Lauf übernimmt Dev Log Merge und Tag.`,
        'Auszug aus `gh run view --log-failed` (gekürzt, Zugangsdaten maskiert):',
        `\`\`\`text\n${excerpt.replace(/```/g, "'''") || '(kein Log)'}\n\`\`\``,
      ].join('\n\n'),
    ],
  );
}

/**
 * Nach dem Merge auf GitHub: main holen, den Sprint-Tag wie bisher setzen und pushen und das lokale main nachziehen,
 * sofern es nicht in einem anderen Ordner ausgecheckt ist (dort bleibt es beim Hinweis).
 */
export async function tagMergedSprint(
  cwd: string,
  sprint: { id: string; name: string },
  rawExecute: CommandExecutor = runCommand,
): Promise<{ commit: string; log: string[]; mainUpdated: boolean }> {
  const execute: CommandExecutor = (command, directory, options) =>
    withProjectLock(cwd, () => rawExecute(command, directory, options));
  const { git, must } = gitHelpers(execute, cwd);
  const log: string[] = [];
  let mainUpdated = false;
  const remoteMain = `refs/remotes/origin/${MAIN_BRANCH}`;
  await must('fetch', 'origin', `+refs/heads/${MAIN_BRANCH}:${remoteMain}`);
  const tag = sprintTag(sprint.name, sprint.id);
  await must('tag', '-f', tag, remoteMain);
  await must('push', '--force', 'origin', `refs/tags/${tag}`);
  log.push(`Pull Request gemergt, Tag ${tag} gepusht.`);
  const head = (await git('rev-parse', '--abbrev-ref', 'HEAD')).output;
  const elsewhere = head === MAIN_BRANCH ? null : await checkedOutElsewhere(git, MAIN_BRANCH, cwd);
  if (elsewhere) {
    log.push(`${MAIN_BRANCH} ist in ${elsewhere} ausgecheckt – dort mit „git pull“ übernehmen.`);
  } else {
    // Nur Fast-Forward: lokale Commits auf main gehen nie verloren.
    const updated =
      head === MAIN_BRANCH
        ? await git('merge', '--ff-only', remoteMain)
        : await git('fetch', 'origin', `${MAIN_BRANCH}:${MAIN_BRANCH}`);
    mainUpdated = updated.exitCode === 0;
    log.push(
      mainUpdated
        ? `Lokales ${MAIN_BRANCH} aktualisiert.`
        : `Lokales ${MAIN_BRANCH} weicht ab – bitte mit „git pull“ übernehmen.`,
    );
  }
  return { commit: await must('rev-parse', '--short', remoteMain), log, mainUpdated };
}

/**
 * Verfolgt Sprints im Review (PR-Modus): CI-Status speichern, bei roter CI einen Bug je Lauf anlegen, bei grüner CI
 * (und, falls gefordert, nach Approve) mergen und taggen. Wurde der Pull Request von Hand gemergt, wird nur getaggt.
 * Gibt die Zahl der abgeschlossenen Sprints zurück.
 */
export async function pollSprintReviews(
  pool: Pool,
  project: string,
  cwd: string,
  adapter: HosterAdapter,
  requireApproval: boolean,
  rawExecute: CommandExecutor = runCommand,
  /** Nach dem Merge des Pull Requests „Live schalten“ wie beim direkten Merge (goLive). */
  onMergedMain?: () => Promise<boolean | null | void>,
): Promise<number> {
  const sprints = (
    await pool.query<ReviewSprint>(
      `SELECT id, name, pr_url AS "prUrl", ci_status AS "ciStatus", ci_bug_run AS "ciBugRun" FROM sprints
        WHERE project_slug = $1 AND status = 'review' AND pr_url IS NOT NULL ORDER BY updated_at`,
      [project],
    )
  ).rows;
  let finished = 0;
  for (const sprint of sprints) {
    const pr = await adapter.pullRequestState(sprint.prUrl);
    if (pr.state === 'closed') {
      await pool.query(
        `UPDATE sprints SET status = 'completed', git_sync = 'failed', git_message = $2, git_synced_at = NOW()
          WHERE id = $1 AND status = 'review'`,
        [
          sprint.id,
          `Pull Request ${sprint.prUrl} wurde ohne Merge geschlossen – ${MAIN_BRANCH} bleibt unverändert. ` +
            'Sprint-Branch manuell übernehmen oder die Git-Sicherung erneut starten.',
        ],
      );
      continue;
    }
    let ciStatus = sprint.ciStatus;
    if (pr.state === 'open') {
      const checks = await adapter.pullRequestChecks(sprint.prUrl);
      ciStatus = checks.status;
      if (checks.status !== sprint.ciStatus) {
        await pool.query(`UPDATE sprints SET ci_status = $2 WHERE id = $1`, [sprint.id, checks.status]);
      }
      if (checks.status === 'failure') {
        if (checks.failedRun && checks.failedRun !== sprint.ciBugRun) {
          await reportCiFailure(pool, project, sprint, checks.failedRun, adapter);
        }
        continue;
      }
      if (checks.status === 'pending') continue;
      if (requireApproval && !pr.approved) {
        await pool.query(`UPDATE sprints SET git_message = $2 WHERE id = $1`, [
          sprint.id,
          `CI grün – wartet auf Freigabe (Approve) im Pull Request ${sprint.prUrl}.`,
        ]);
        continue;
      }
      await adapter.mergePullRequest(sprint.prUrl);
    }
    const tagged = await tagMergedSprint(cwd, sprint, rawExecute);
    // Nur mit nachgezogenem lokalem main: sonst würde der alte Stand deployt.
    if (tagged.mainUpdated && onMergedMain) await goLiveLogged(onMergedMain, tagged.log);
    await pool.query(
      `UPDATE sprints SET status = 'completed', ci_status = $5, git_sync = 'done', git_message = $2, git_commit = $3,
              git_branch = $4, git_synced_at = NOW() WHERE id = $1`,
      [sprint.id, tagged.log.join(' '), tagged.commit, MAIN_BRANCH, ciStatus],
    );
    finished += 1;
  }
  return finished;
}
