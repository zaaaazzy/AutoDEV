import { existsSync, realpathSync } from 'node:fs';
import { appendFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Pool } from 'pg';
import { withProjectLock } from '../core/project-lock.js';
import { type CommandExecutor, redactOutput, runCommand } from '../core/command.js';
import { loadTestCommands } from './runner-selection.js';
import { requestRestart } from './system-restart.js';

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

/** Inhalte, die nach Zugangsdaten aussehen (private Schlüssel, Cloud- und Git-Tokens). */
const SECRET_CONTENT = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{36}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{40,}/,
  /\bsk-ant-[A-Za-z0-9_-]{20,}/,
  /\bsk-(?:proj-)?[A-Za-z0-9]{32,}/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
];

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

/** Hält Agent-Sicherungen, Anhänge und .env-Dateien aus dem automatischen Commit heraus (lokal, ohne .gitignore zu ändern). */
async function excludeInternalFolders(cwd: string): Promise<void> {
  const file = join(cwd, '.git', 'info', 'exclude');
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

function gitHelpers(execute: CommandExecutor, cwd: string) {
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new',
  };
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
async function stageAll(git: GitHelpers['git'], must: GitHelpers['must'], log?: string[]): Promise<string[]> {
  await must('add', '-A');
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

/** Initialisiert das Repository bei Bedarf, setzt eine Commit-Identität und schließt interne Ordner aus. Gibt zurück, ob neu initialisiert wurde. */
async function ensureRepository(git: GitHelpers['git'], must: GitHelpers['must'], cwd: string): Promise<boolean> {
  let initialized = false;
  if (!existsSync(join(cwd, '.git'))) {
    await must('init', '-b', 'main');
    initialized = true;
  }
  if (!(await git('config', 'user.email')).output) {
    await must('config', 'user.name', 'AIdeation');
    await must('config', 'user.email', 'dev-log@mainty.local');
  }
  await excludeInternalFolders(cwd);
  return initialized;
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
}

/**
 * Wechselt für einen Auftrag auf seinen eigenen Branch: bei Sprint-Aufträgen vom Sprint-Branch abgezweigt, sonst vom
 * aktuellen Branch. Existiert der Branch schon (erneuter Versuch), wird er fortgesetzt und der Basis-Stand eingemergt.
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
    if (sprintName) await checkoutSprintBranch(cwd, sprintName, rawExecute);
    let base = await must('rev-parse', '--abbrev-ref', 'HEAD');
    const branch = orderBranch(item);
    if (base === branch) {
      // Nach einem Abbruch steht der Ordner noch auf dem Auftrags-Branch.
      base = sprintName ? sprintBranch(sprintName) : MAIN_BRANCH;
      return { branch, base };
    }
    if (!(await git('rev-parse', '--verify', '--quiet', 'HEAD')).exitCode) {
      if (await branchExists(git, branch)) {
        await must('checkout', branch);
        const merged = await git('merge', '--no-edit', base);
        if (merged.exitCode !== 0) await git('merge', '--abort');
      } else {
        await must('checkout', '-b', branch);
      }
    } else {
      // Leeres Repository ohne Commit: Branch direkt anlegen.
      await must('checkout', '-b', branch);
    }
    return { branch, base };
  } catch (error) {
    console.error(
      `Auftrags-Branch für ${item.id} nicht aktiv: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
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
  try {
    // Wie bei allen Auftrags-Commits: Dateien, die nach Zugangsdaten aussehen, bleiben außen vor.
    await stageAll(git, must);
    const dirty = Boolean(await must('diff', '--cached', '--name-only'));
    if (passed) {
      if (dirty) {
        const [subject, body] = taskCommitMessage(item.kind, sprintName, item.title, item.id);
        await must('commit', '-m', subject, '-m', body);
      }
      // Review-Freigabe: Branch bleibt bestehen und wird erst nach der Freigabe gemergt (mergeApprovedBranch).
      if (hold) {
        const changed = await git('diff', '--name-only', `${target.base}...${target.branch}`);
        if (hold(changed.exitCode === 0 ? changed.output.split('\n').filter(Boolean) : [])) {
          await must('checkout', target.base);
          return {
            merged: false,
            held: true,
            commit: null,
            message: `Wartet auf Freigabe – ${target.branch} wird danach in ${target.base} gemergt.`,
          };
        }
      }
      await must('checkout', target.base);
      const merged = await git(
        'merge',
        '--no-ff',
        target.branch,
        '-m',
        `Merge ${target.branch}: ${item.title.slice(0, 72)}`,
      );
      if (merged.exitCode !== 0) {
        await git('merge', '--abort');
        return {
          merged: false,
          commit: null,
          message: `Merge-Konflikt mit ${target.base} – Branch ${target.branch} bleibt bestehen.`,
        };
      }
      await git('branch', '-d', target.branch);
      return {
        merged: true,
        commit: await must('rev-parse', '--short', 'HEAD'),
        message: `In ${target.base} gemergt.`,
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
    await must('checkout', target.base);
    return { merged: false, commit: null, message: `Zwischenstand auf ${target.branch} gesichert.` };
  } catch (error) {
    return { merged: false, commit: null, message: error instanceof Error ? error.message : String(error) };
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
    '-m',
    'ci: GitHub-Actions-Workflow für Build und Tests',
    '-m',
    'Automatisch angelegt vom AIdeation.',
  );
  log.push('CI-Workflow (GitHub Actions) angelegt.');
}

/**
 * Wartet auf den GitHub-Actions-Lauf für den gepushten Stand (über die gh CLI). Ohne gh bleibt das lokale Test-Gate
 * maßgeblich; ein roter CI-Lauf verhindert den Merge nach main.
 */
async function waitForCi(execute: CommandExecutor, cwd: string, branch: string, log: string[]): Promise<void> {
  const env = { ...process.env, GH_PROMPT_DISABLED: '1' };
  const gh = async (...args: string[]) => execute(['gh', ...args], cwd, { timeoutMs: CI_WAIT_MS, env });
  const auth = await gh('auth', 'status', '--hostname', 'github.com').catch(() => null);
  if (!auth || auth.exitCode !== 0) {
    log.push('CI-Status nicht prüfbar (GitHub CLI fehlt oder ist nicht angemeldet) – das lokale Test-Gate gilt.');
    return;
  }
  const sha = (await execute(['git', 'rev-parse', 'HEAD'], cwd, { timeoutMs: GIT_TIMEOUT_MS })).output.trim();
  let runId = '';
  for (let attempt = 0; attempt < 24 && !runId; attempt += 1) {
    const list = await gh(
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
  const watched = await gh('run', 'watch', runId, '--exit-status');
  if (watched.exitCode !== 0) {
    throw new Error(
      `Merge nach main abgelehnt: CI-Lauf ${runId} auf ${branch} ist rot. ${redactOutput(watched.output, process.env).slice(-400)}`,
    );
  }
  log.push(`CI grün (Lauf ${runId}).`);
}

/** Führt die Testbefehle des Projekts aus; wirft mit dem Ausgabe-Ende, sobald einer fehlschlägt. */
async function runTestGate(execute: CommandExecutor, cwd: string, commands: string[][], log: string[]): Promise<void> {
  for (const command of commands) {
    const result = await execute(command, cwd, { timeoutMs: TEST_TIMEOUT_MS });
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
    await must('commit', '-m', subject, '-m', body);
    return await must('rev-parse', '--short', 'HEAD');
  } catch (error) {
    console.error(
      `Auftrags-Commit für ${item.id} fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

interface PendingSprint {
  id: string;
  name: string;
  action: 'push' | 'pull' | null;
  remote: string | null;
  status: string;
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
  ci: { cwd: string; commands: string[][]; execute: CommandExecutor; mergeElsewhere?: boolean },
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
      '-m',
      `chore(${sprint.name}): Sprint-Stand sichern`,
      '-m',
      'Automatisch gesichert vom AIdeation.',
    );
    log.push('Reständerungen committet.');
  }
  if (sprint.remote && /github\.com/.test(sprint.remote)) await ensureCiWorkflow(ci.cwd, ci.commands, helpers, log);
  await gate(log);
  let current = await must('rev-parse', '--abbrev-ref', 'HEAD');
  if (sprint.remote) {
    await must('push', '-u', 'origin', current);
    log.push(`${current} nach GitHub gepusht.`);
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
      const merged = await git('merge', '--no-ff', branch, '-m', `Merge ${branch}: Sprint ${sprint.name}`);
      if (merged.exitCode !== 0) {
        await git('merge', '--abort');
        await must('checkout', branch);
        throw new Error(
          `Merge von ${branch} nach ${MAIN_BRANCH} hat Konflikte – bitte manuell zusammenführen. ${merged.output.slice(-300)}`,
        );
      }
      await gate(log);
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
  const git = (...args: string[]) => execute(['git', ...args], folder, { timeoutMs: 120_000 });
  const head = await git('rev-parse', '--abbrev-ref', 'HEAD');
  const status = await git('status', '--porcelain', '--untracked-files=no');
  if (head.exitCode !== 0 || head.output.trim() !== MAIN_BRANCH || status.exitCode !== 0 || status.output.trim()) {
    log.push(
      `Sprint abgeschlossen: ${branch} ist bereit. In ${folder} sind Änderungen offen oder nicht ${MAIN_BRANCH} ausgecheckt – dort mit „git merge ${branch}“ übernehmen; kein automatischer Neustart.`,
    );
    return false;
  }
  const merged = await git('merge', '--no-ff', branch, '-m', `Merge ${branch}: Sprint ${sprintName}`);
  if (merged.exitCode !== 0) {
    await git('merge', '--abort');
    log.push(`Merge von ${branch} nach ${MAIN_BRANCH} in ${folder} hat Konflikte – bitte manuell zusammenführen.`);
    return false;
  }
  try {
    await runTestGate(execute, folder, commands, log);
  } catch (error) {
    await git('reset', '--keep', 'ORIG_HEAD');
    log.push(
      `Test-Gate nach dem Merge in ${folder} rot – Merge zurückgenommen. ${error instanceof Error ? error.message : ''}`.trim(),
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

/** Works through the next queued Git request (push or pull) of the project's sprints. */
export async function syncSprintToGit(
  pool: Pool,
  project: string,
  cwd: string,
  rawExecute: CommandExecutor = runCommand,
): Promise<number> {
  const execute: CommandExecutor = (command, directory, options) =>
    withProjectLock(cwd, () => rawExecute(command, directory, options));
  await pool.query(
    `UPDATE sprints SET git_sync = 'pending' WHERE project_slug = $1 AND git_sync = 'running'
        AND updated_at < NOW() - INTERVAL '30 minutes'`,
    [project],
  );
  const claimed = await pool.query<PendingSprint>(
    `UPDATE sprints s SET git_sync = 'running'
      WHERE s.id = (SELECT id FROM sprints WHERE project_slug = $1 AND git_sync = 'pending'
                     ORDER BY updated_at LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING s.id, s.name, s.status, s.git_action AS action,
                (SELECT git_remote FROM projects WHERE slug = s.project_slug) AS remote`,
    [project],
  );
  const sprint = claimed.rows[0];
  if (!sprint) {
    return 0;
  }
  const helpers = gitHelpers(execute, cwd);
  const log: string[] = [];
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
    const result =
      sprint.action === 'pull'
        ? await pullSprint(helpers, sprint, log)
        : await pushSprint(helpers, sprint, log, gate, {
            cwd,
            commands,
            execute: rawExecute,
            mergeElsewhere: restartAfterSprint,
          });
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
  }
}
