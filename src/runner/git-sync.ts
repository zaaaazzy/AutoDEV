import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Pool } from 'pg';
import { withProjectLock } from '../core/project-lock.js';
import { type CommandExecutor, redactOutput, runCommand } from '../core/command.js';
import { loadTestCommands } from './runner-selection.js';

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
const WIP_PREFIX = 'devlog-wip';
const TEST_TIMEOUT_MS = 15 * 60_000;

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
    await must('config', 'user.name', 'Mainty Dev Log');
    await must('config', 'user.email', 'dev-log@mainty.local');
  }
  await excludeInternalFolders(cwd);
  return initialized;
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

/**
 * Parkt die Änderungen eines fehlgeschlagenen Auftrags als Stash, damit sie nicht im Commit des nächsten Auftrags landen.
 * Geparkt werden nur die Dateien, die der Auftrag laut Verlauf geschrieben hat (`paths`).
 */
export async function shelveFailedWork(
  cwd: string,
  item: { id: string; title: string },
  paths: string[],
  rawExecute: CommandExecutor = runCommand,
): Promise<boolean> {
  const execute: CommandExecutor = (command, directory, options) =>
    withProjectLock(cwd, () => rawExecute(command, directory, options));
  const { git, must } = gitHelpers(execute, cwd);
  // Ohne Repository gibt es nichts zu parken (und es soll dafür keines angelegt werden).
  if (!existsSync(join(cwd, '.git'))) return false;
  try {
    if (!(await must('status', '--porcelain'))) return false;
    const existing = paths.filter(
      (path) => !path.startsWith('/') && !path.includes('..') && existsSync(join(cwd, path)),
    );
    // Ohne bekannte Dateien nichts parken: ein Stash des ganzen Arbeitsstands träfe auch laufende andere Aufträge.
    if (!existing.length) return false;
    const title = item.title.replace(/\s+/g, ' ').slice(0, 60);
    const args = ['stash', 'push', '--include-untracked', '-m', `${WIP_PREFIX} ${item.id} ${title}`];
    const result = await git(...args, '--', ...existing);
    return result.exitCode === 0 && !/No local changes/i.test(result.output);
  } catch (error) {
    console.error(`Auftrag ${item.id} nicht geparkt: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

/** Holt geparkte Änderungen eines Auftrags zurück, wenn er erneut startet. */
export async function restoreShelvedWork(
  cwd: string,
  itemId: string,
  rawExecute: CommandExecutor = runCommand,
): Promise<boolean> {
  const execute: CommandExecutor = (command, directory, options) =>
    withProjectLock(cwd, () => rawExecute(command, directory, options));
  const { git } = gitHelpers(execute, cwd);
  if (!existsSync(join(cwd, '.git'))) return false;
  const list = await git('stash', 'list', '--format=%gd %s');
  const ref = list.output
    .split('\n')
    .find((line) => line.includes(`${WIP_PREFIX} ${itemId}`))
    ?.split(' ')[0];
  if (!ref) return false;
  const popped = await git('stash', 'pop', ref);
  if (popped.exitCode !== 0)
    console.error(`Geparkte Arbeit für ${itemId} nicht übernommen: ${popped.output.slice(-300)}`);
  return popped.exitCode === 0;
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
    `Auftrag: ${itemId}\nSprint: ${sprintName}\nAutomatisch erstellt vom Mainty Dev Log.`,
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
): Promise<SyncResult> {
  const { git, must } = helpers;
  const branch = sprintBranch(sprint.name);
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
      'Automatisch gesichert vom Mainty Dev Log.',
    );
    log.push('Reständerungen committet.');
  }
  await gate(log);
  let current = await must('rev-parse', '--abbrev-ref', 'HEAD');
  if (sprint.remote) {
    await must('push', '-u', 'origin', current);
    log.push(`${current} nach GitHub gepusht.`);
  }
  if (sprint.status === 'completed' && current === branch) {
    if (await branchExists(git, MAIN_BRANCH)) {
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
    current = MAIN_BRANCH;
    log.push(`Sprint abgeschlossen: ${branch} nach ${MAIN_BRANCH} gemergt.`);
    if (sprint.remote) await must('push', '-u', 'origin', MAIN_BRANCH);
  }
  const tag = sprintTag(sprint.name, sprint.id);
  await must('tag', '-f', tag);
  if (sprint.remote) {
    await must('push', '--force', 'origin', `refs/tags/${tag}`);
    log.push(`Tag ${tag} gepusht.`);
  } else {
    log.push('Kein GitHub-Repository am Projekt hinterlegt – nur lokal gesichert.');
  }
  return { commit: await must('rev-parse', '--short', 'HEAD'), branch: current, log };
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
    const gate = (entries: string[]) => runTestGate(rawExecute, cwd, commands, entries);
    const result =
      sprint.action === 'pull' ? await pullSprint(helpers, sprint, log) : await pushSprint(helpers, sprint, log, gate);
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
