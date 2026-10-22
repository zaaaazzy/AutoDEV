// Git-Grundlagen: Befehlsausführung, Remotes, Branch-Namen, Zugangsdaten-Schutz und Sprint-Branch.
import { existsSync, realpathSync } from 'node:fs';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { withProjectLock } from '../../core/project-lock.js';
import { type CommandExecutor, redactOutput, runCommand } from '../../core/command.js';
import { SECRET_PATTERNS } from '../../core/secret-mask.js';
import { BACKUP_DIRECTORY } from '../../agent/tool-paths.js';
import { gitEnvironment } from '../project-command.js';
import { clearStaleIndexLock, isIndexLockError } from './stale-lock.js';

export const GIT_TIMEOUT_MS = 120_000;
const REMOTE_PATTERN = /^(https:\/\/[^\s@/]+\/[^\s]+|git@[A-Za-z0-9.-]+:[^\s]+|ssh:\/\/git@[^\s]+)$/;

export function isValidGitRemote(value: string): boolean {
  return value.length <= 300 && REMOTE_PATTERN.test(value);
}

/** Der Worker läuft ohne Terminal und Zugangsdaten-Dialog: GitHub-HTTPS-Adressen werden über SSH (Schlüssel) gepusht. */
export function pushRemote(remote: string): string {
  const match = remote.match(/^https:\/\/github\.com\/([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/);
  return match ? `git@github.com:${match[1]}.git` : remote;
}

export function slugify(name: string): string {
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

/**
 * Sprint-Tag unmittelbar vor `current` (Rollback-Ziel). `tags` sind die Tags der abgeschlossenen Sprints, ältester
 * zuerst. Nur genau ein Schritt zurück; ist `current` unbekannt oder der älteste Tag, gibt es kein Ziel (null).
 */
export function previousSprintTag(tags: readonly string[], current: string | null | undefined): string | null {
  if (!current) return null;
  const index = tags.lastIndexOf(current);
  return index > 0 ? (tags[index - 1] ?? null) : null;
}

/** Branch, auf dem alle Aufträge eines Sprints committet werden; am Sprintende wird er nach main gemergt. */
export function sprintBranch(name: string): string {
  return `sprint/${slugify(name)}`;
}

export const MAIN_BRANCH = 'main';

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
export const SECRET_CONTENT = SECRET_PATTERNS;

/** Dateien, deren hinzugefügte Zeilen im Diff nach Zugangsdaten aussehen. */
/**
 * Pfad aus einer Diff-Kopfzeile („+++ b/pfad“). Git hängt bei Namen mit Leerzeichen einen Tab an und setzt Namen mit
 * Sonderzeichen in Anführungszeichen mit C-Escapes („+++ "b/zug\303\244nge.txt"“) – beides muss gelesen werden, sonst
 * rutschen Dateien mit Zugangsdaten durch die Prüfung.
 */
export function diffTargetPath(header: string): string | null {
  let rest = header.slice(4);
  if (rest.startsWith('"') && rest.endsWith('"')) {
    const bytes: number[] = [];
    const inner = rest.slice(1, -1);
    for (let index = 0; index < inner.length; index++) {
      const char = inner[index]!;
      if (char !== '\\') {
        bytes.push(...Buffer.from(char, 'utf8'));
        continue;
      }
      const next = inner[index + 1] ?? '';
      if (/[0-7]/.test(next)) {
        bytes.push(parseInt(inner.slice(index + 1, index + 4), 8));
        index += 3;
      } else {
        const escapes: Record<string, string> = {
          t: '\t',
          n: '\n',
          '"': '"',
          '\\': '\\',
          a: '\x07',
          b: '\b',
          f: '\f',
          r: '\r',
          v: '\v',
        };
        bytes.push(...Buffer.from(escapes[next] ?? next, 'utf8'));
        index += 1;
      }
    }
    rest = Buffer.from(bytes).toString('utf8');
  } else {
    rest = rest.replace(/\t$/, '');
  }
  return rest.startsWith('b/') ? rest.slice(2) : null;
}

export function filesWithSecrets(diff: string): string[] {
  const found = new Set<string>();
  let file: string | null = null;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      file = diffTargetPath(line);
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

export function gitHelpers(execute: CommandExecutor, cwd: string) {
  // Gefiltert und ohne Hooks: Agents können im Projekt Hooks oder fsmonitor setzen, die sonst beim Commit liefen.
  const env = gitEnvironment({
    ...BOT_IDENTITY,
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new',
  });
  const run = async (args: string[]) => {
    const result = await execute(['git', ...args], cwd, { timeoutMs: GIT_TIMEOUT_MS, env });
    return { ...result, output: redactOutput(result.output, process.env).trim() };
  };
  const git = async (...args: string[]) => {
    const result = await run(args);
    // Verwaiste index.lock (git wurde hart beendet): wegräumen, wenn niemand sie hält, und einmal neu versuchen.
    if (result.exitCode !== 0 && isIndexLockError(result.output) && (await clearStaleIndexLock(cwd))) {
      return run(args);
    }
    return result;
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

export type GitHelpers = ReturnType<typeof gitHelpers>;

/**
 * „git add -A“ mit Schutz: Dateien, die nach Zugangsdaten aussehen, werden wieder aus dem Index genommen
 * (sie bleiben im Arbeitsverzeichnis) und gemeldet. Gibt die zurückgehaltenen Dateien zurück.
 */
export async function stageAll(
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
  const diff = await git('-c', 'core.quotePath=false', 'diff', '--cached', '--no-color', '--no-ext-diff', '-U0');
  const held = diff.exitCode === 0 ? filesWithSecrets(diff.output) : [];
  if (!held.length) return held;
  const hasHead = (await git('rev-parse', '--verify', '--quiet', 'HEAD')).exitCode === 0;
  // Wörtliche Pfade: Sonderzeichen wie * oder [ im Namen dürfen keinen Mustervergleich auslösen.
  await must(
    ...(hasHead ? ['reset', '-q', '--'] : ['rm', '--cached', '-q', '--']),
    ...held.map((file) => `:(literal)${file}`),
  );
  const message = `Nicht committet, weil sie nach Zugangsdaten aussehen: ${held.join(', ')}`;
  if (log) log.push(message);
  else console.warn(message);
  return held;
}

/** Initialisiert das Repository bei Bedarf und schließt interne Ordner aus (Identität: BOT_IDENTITY). Gibt zurück, ob neu initialisiert wurde. */
export async function ensureRepository(
  git: GitHelpers['git'],
  must: GitHelpers['must'],
  cwd: string,
): Promise<boolean> {
  let initialized = false;
  if (!existsSync(join(cwd, '.git'))) {
    await must('init', '-b', 'main');
    initialized = true;
  }
  await excludeInternalFolders(git, cwd);
  return initialized;
}

/** Aktueller Branch; „HEAD“ bei losgelöstem Stand. Funktioniert auch in einem Repository ohne Commit. */
export async function currentBranch(git: GitHelpers['git']): Promise<string> {
  const ref = await git('symbolic-ref', '--short', '-q', 'HEAD');
  return ref.exitCode === 0 && ref.output ? ref.output : 'HEAD';
}

/**
 * Sichert einen Arbeitsstand als Patch unter .dev-log-backups, bevor git ihn verwirft (z. B. `merge --abort`).
 * Liefert den Pfad oder null, wenn nichts zu sichern war.
 */
export async function backupWorkingTree(git: GitHelpers['git'], cwd: string, label: string): Promise<string | null> {
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

export async function branchExists(git: GitHelpers['git'], branch: string): Promise<boolean> {
  return (await git('rev-parse', '--verify', '--quiet', `refs/heads/${branch}`)).exitCode === 0;
}

/**
 * Wechselt vor der Arbeit an einem Sprint-Auftrag auf den Sprint-Branch (legt ihn bei Bedarf von main an).
 * Ungespeicherte Änderungen wandern mit; scheitert der Wechsel, bleibt der aktuelle Branch und es wird geloggt.
 */
/**
 * Basis für einen neuen Sprint-Branch: der neueste Stand von main. Liegt GitHub vorn (z. B. ein gemergter Pull
 * Request des Vorgänger-Sprints) und hat das lokale main nichts Eigenes, zählt origin/main – sonst fehlte dem neuen
 * Sprint die Arbeit des vorigen. Ohne Remote oder bei eigenen lokalen Commits bleibt es beim lokalen main.
 */
async function freshestMain(git: GitHelpers['git']): Promise<string> {
  if (!(await git('remote')).output.split('\n').includes('origin')) return MAIN_BRANCH;
  await git('fetch', '-q', 'origin', MAIN_BRANCH);
  const remote = `refs/remotes/origin/${MAIN_BRANCH}`;
  if ((await git('rev-parse', '--verify', '--quiet', remote)).exitCode !== 0) return MAIN_BRANCH;
  const behindOnly = (await git('merge-base', '--is-ancestor', MAIN_BRANCH, remote)).exitCode === 0;
  return behindOnly ? remote : MAIN_BRANCH;
}

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
    else if (await branchExists(git, MAIN_BRANCH))
      await must('checkout', '--no-track', '-b', branch, await freshestMain(git));
    else await must('checkout', '-b', branch);
    return branch;
  } catch (error) {
    console.error(`Sprint-Branch ${branch} nicht aktiv: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/** Interne Ordner, die nie als geänderte Datei eines Auftrags zählen (Agent-Ablage, Testberichte). */
export const CHANGED_FILES_IGNORED = ['.dev-log/', 'docs/tests/'];

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

/**
 * Pfad aus einer Zeile von `git status --porcelain` (mit `core.quotePath=false`). Robust gegen das Trimmen der
 * Ausgabe durch `gitHelpers`: Die erste Zeile verliert dort ihr führendes Leerzeichen („ M docs/a.md“ → „M docs/a.md“),
 * ein festes `slice(3)` schnitte dann den ersten Buchstaben des Pfads ab („ocs/a.md“) – und ignorierte Pfade wie
 * docs/tests/ gälten als fremd. Bei Umbenennungen zählt das Ziel.
 */
export function porcelainPath(line: string): string {
  return line
    .replace(/^[ MADRCUT?!]{1,2}\s+/, '')
    .replace(/^.* -> /, '')
    .trim();
}
