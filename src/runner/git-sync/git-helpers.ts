// Git-Grundlagen: Befehlsausführung, Remotes, Branch-Namen, Zugangsdaten-Schutz und Sprint-Branch.
import { existsSync, realpathSync } from 'node:fs';
import { appendFile, mkdir, readFile, realpath, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { createProjectDirectory, isInside, readProjectFile, writeNewProjectFile } from '../../core/project-paths.js';
import { withProjectLock } from '../../core/project-lock.js';
import { type CommandExecutor, redactOutput, runCommand } from '../../core/command.js';
import { SECRET_PATTERNS } from '../../core/secret-mask.js';
import { BACKUP_DIRECTORY } from '../../agent/tool-paths.js';
import { gitEnvironment } from '../project-command.js';
import { clearStaleLock, lockedFile } from './stale-lock.js';
import { checkoutTarget, dropReportCopies, REPORT_DIRECTORIES } from './report-copies.js';

export { REPORT_DIRECTORIES };

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

/** Sprint mit dem beim Start festgehaltenen Branch (sprints.branch); der Name dient nur noch der Anzeige. */
export interface SprintRef {
  name: string;
  branch?: string | null;
}

/**
 * Branch eines Sprints: der gespeicherte (beim Start vergeben, ändert sich beim Umbenennen nicht). Nur ohne
 * gespeicherten Branch (geplanter Sprint, reiner Name in Tests) wird er aus dem Namen gebildet.
 */
export function sprintBranchOf(sprint: SprintRef | string): string {
  return typeof sprint === 'string' ? sprintBranch(sprint) : sprint.branch || sprintBranch(sprint.name);
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
      const char = inner.charAt(index);
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

/** Testdateien, in denen eindeutige Testwerte (Platzhalter oder markiert) nicht als Zugangsdaten zählen. */
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
/** Markierung für einen erfundenen Wert in einer Testdatei: in derselben oder der Zeile direkt davor. */
export const TEST_VALUE_MARKER = /dev-log:\s*testwert/i;
const PLACEHOLDER_WORD = /example|beispiel|dummy|fake|placeholder|platzhalter|redacted|x{6,}/i;

/** Mindestens `length` aufsteigende Zeichen am Stück („abcdef“, „AbCdEf“, „123456“) – in echten Schlüsseln praktisch nie. */
function hasAscendingRun(text: string, length: number): boolean {
  const lower = text.toLowerCase();
  let run = 1;
  for (let index = 1; index < lower.length; index++) {
    const ascending =
      /[a-z0-9]/.test(lower.charAt(index)) && lower.charCodeAt(index) === lower.charCodeAt(index - 1) + 1;
    run = ascending ? run + 1 : 1;
    if (run >= length) return true;
  }
  return false;
}

/** Bekannte Platzhaltermuster: Wörter wie EXAMPLE/FAKE, lange Wiederholungen („aaaaaaaa“) oder Folgen („abcdef“). */
export function isPlaceholderToken(token: string): boolean {
  return PLACEHOLDER_WORD.test(token) || /(.)\1{7,}/.test(token) || hasAscendingRun(token, 6);
}

/** PEM-Kopf in einer Testzeile: nur ein Platzhalter, wenn der Block in derselben Zeile kurz bzw. erfunden endet. */
function isPlaceholderPem(line: string, index: number, header: string): boolean {
  const rest = line.slice(index + header.length);
  const end = rest.search(/-----END [A-Z ]*PRIVATE KEY-----/);
  if (end < 0) return false;
  const body = rest.slice(0, end).replace(/\\n|\s/g, '');
  return body.length < 40 || isPlaceholderToken(body);
}

/** Jede Fundstelle der Zeile ist ein eindeutiger Testwert (nur für Testdateien gefragt). */
function onlyTestValues(line: string): boolean {
  for (const pattern of SECRET_CONTENT) {
    for (const match of line.matchAll(new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`))) {
      const placeholder = match[0].startsWith('-----BEGIN')
        ? isPlaceholderPem(line, match.index, match[0])
        : isPlaceholderToken(match[0]);
      if (!placeholder) return false;
    }
  }
  return true;
}

/**
 * Dateien, deren hinzugefügte Zeilen im Diff nach Zugangsdaten aussehen. In *.test.ts/*.spec.ts zählen eindeutige
 * Testwerte nicht: markierte Zeilen (TEST_VALUE_MARKER) und Fundstellen nach bekannten Platzhaltermustern. Echte
 * Schlüssel bleiben auch dort zurückgehalten – geprüft wird jede Fundstelle einzeln.
 */
export function filesWithSecrets(diff: string): string[] {
  const found = new Set<string>();
  let file: string | null = null;
  let previous = '';
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      file = diffTargetPath(line);
      previous = '';
      continue;
    }
    const added = line.startsWith('+') ? line : '';
    if (file && added && SECRET_CONTENT.some((pattern) => pattern.test(added))) {
      const testValue =
        TEST_FILE.test(file) &&
        (TEST_VALUE_MARKER.test(added) || TEST_VALUE_MARKER.test(previous) || onlyTestValues(added));
      if (!testValue) found.add(file);
    }
    previous = added;
  }
  return [...found];
}

/**
 * Zurückgehaltene Dateien aus dem Arbeitsordner nehmen: Kopie unter BACKUP_DIRECTORY, versionierte Dateien auf HEAD
 * zurück, neue gelöscht. Sonst wanderten sie beim Checkout mit und der nächste Auftrag scheiterte an „fremden
 * Änderungen“. Liefert den Sicherungsordner (relativ zum Projekt).
 */
const SET_ASIDE_MAX_BYTES = 50 * 1024 * 1024;

/** Liegt der Ordner `relative` wirklich im Projekt (auch nach Auflösen von Links)? Sonst nichts darin löschen. */
async function insideProject(cwd: string, relative: string): Promise<boolean> {
  const [root, real] = await Promise.all([realpath(cwd), realpath(join(cwd, relative))]).catch(() => [null, null]);
  return Boolean(root && real && isInside(root, real));
}

export async function setAsideFiles(
  git: GitHelpers['git'],
  cwd: string,
  files: string[],
  label: string,
): Promise<string> {
  const folder = join(BACKUP_DIRECTORY, `${label}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  for (const file of files) {
    // Ohne Links zu folgen: ein Symlink `leak -> ~/.ssh/id_ed25519` mit Zugangsdaten-Muster im Ziel landete sonst mit
    // dem Inhalt der Host-Datei in der Sicherung – im Projekt, also für den Agent lesbar. Links werden nicht gesichert.
    const data = await readProjectFile(cwd, file, SET_ASIDE_MAX_BYTES);
    if (data) {
      const directory = await createProjectDirectory(cwd, join(folder, dirname(file)));
      if (directory) await writeNewProjectFile(directory, basename(file), data);
    }
    if ((await git('cat-file', '-e', `HEAD:${file}`)).exitCode === 0) {
      await git('checkout', 'HEAD', '--', `:(literal)${file}`);
    } else if (await insideProject(cwd, dirname(file))) {
      await unlink(join(cwd, file)).catch(() => undefined);
    }
  }
  return folder;
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

type GitRun = (args: string[]) => Promise<{ exitCode: number; output: string }>;

/** Wartezeit vor dem zweiten Versuch, wenn ein anderer Prozess die Sperre gerade hält. */
export const LOCK_RETRY_DELAY_MS = 2_000;

/** Branches bzw. Commits, die ein `git merge …` übernehmen soll (ohne Optionen und die Nachricht nach `-m`). */
export function mergeSources(args: readonly string[]): string[] {
  const sources: string[] = [];
  let message = false;
  for (const arg of args.slice(1)) {
    if (message) message = false;
    else if (arg === '-m') message = true;
    else if (!arg.startsWith('-')) sources.push(arg);
  }
  return sources;
}

/**
 * Ein Merge (Strategie ort), der an einer Sperre scheitert, hat die neuen Dateien des Quell-Branchs schon in den Ordner
 * geschrieben, aber nicht in den Index: Sie bleiben unversioniert liegen, „merge --abort“ greift nicht (kein MERGE_HEAD),
 * und jeder weitere Merge scheitert an „untracked working tree files would be overwritten“ – oder „git add -A“ nimmt sie
 * in den nächsten Commit. Entfernt werden nur unversionierte Dateien, deren Inhalt genau dem Quell-Branch entspricht.
 */
async function removeMergeLeftovers(run: GitRun, cwd: string, sources: string[]): Promise<void> {
  if (!sources.length) return;
  const untracked = await run(['ls-files', '-z', '--others', '--exclude-standard']);
  if (untracked.exitCode !== 0) return;
  for (const path of untracked.output.split('\0').filter(Boolean).slice(0, 500)) {
    const here = await run(['hash-object', '--', path]);
    if (here.exitCode !== 0) continue;
    for (const source of sources) {
      const blob = await run(['rev-parse', '-q', '--verify', `${source}:${path}`]);
      if (blob.exitCode === 0 && blob.output === here.output) {
        await unlink(join(cwd, path)).catch(() => undefined);
        break;
      }
    }
  }
}

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
    // Diffs ohne Token-Maske: stageAll sucht darin nach Zugangsdaten (filesWithSecrets), sonst fände es keine mehr.
    const tokens = !args.includes('diff');
    return { ...result, output: redactOutput(result.output, process.env, { tokens }).trim() };
  };
  const git = async (...args: string[]) => {
    // Lose Testberichte, die das Ziel unverändert enthält, würden den Checkout abbrechen: vorher wegräumen.
    const target = args[0] === 'checkout' ? checkoutTarget(args) : null;
    if (target) await dropReportCopies((...inner) => run(inner), cwd, target);
    let result = await run(args);
    // Sperrdatei (index.lock, AUTO_MERGE.lock, Ref-Sperre): verwaist (git wurde hart beendet) → wegräumen, sonst kurz
    // warten; dann einmal neu versuchen. Ein so gescheiterter Merge hinterlässt Dateien, die vorher weg müssen.
    const lock = result.exitCode === 0 ? null : lockedFile(result.output);
    if (!lock) return result;
    if (args[0] === 'merge') await removeMergeLeftovers(run, cwd, mergeSources(args));
    if (!(await clearStaleLock(cwd, { file: lock }).catch(() => null))) {
      await new Promise((done) => setTimeout(done, LOCK_RETRY_DELAY_MS));
    }
    result = await run(args);
    if (result.exitCode !== 0 && args[0] === 'merge' && lockedFile(result.output)) {
      await removeMergeLeftovers(run, cwd, mergeSources(args));
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
  // Auftrags-Commits: Berichte und Agent-Ablage gehören nicht zum Auftrag (sie kommen mit der Sprint-Sicherung).
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
  // Ohne Links zu folgen: ein auf einen Host-Ordner umgebogenes .dev-log-backups bekäme sonst die Patch-Datei.
  const directory = await createProjectDirectory(cwd, BACKUP_DIRECTORY);
  const name = `${label}-${new Date().toISOString().replace(/[:.]/g, '-')}.patch`;
  if (!directory || !(await writeNewProjectFile(directory, name, Buffer.from(`${diff.output}\n`)))) return null;
  return join(directory, name);
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
 * Enthält `target` (Standard main) den Stand `revision`? Exit 1 von `git merge-base --is-ancestor` heisst „nein“
 * (noch nicht übernommen); jeder andere Fehler (unbekannter Stand, kaputtes Repository) wirft – er ist weder „ja“
 * noch „nein“.
 */
export async function mainContains(git: GitHelpers['git'], revision: string, target = MAIN_BRANCH): Promise<boolean> {
  const result = await git('merge-base', '--is-ancestor', revision, target);
  if (result.exitCode === 0) return true;
  if (result.exitCode === 1) return false;
  const detail = result.output.trim().slice(-200) || `Exit-Code ${result.exitCode}`;
  throw new Error(`Prüfung, ob ${target} den Stand ${revision} enthält, fehlgeschlagen: ${detail}`);
}

/**
 * Basis für einen neuen Sprint-Branch: der neueste Stand von main. Liegt GitHub vorn (z. B. ein gemergter Pull
 * Request des Vorgänger-Sprints) und hat das lokale main nichts Eigenes, zählt origin/main – sonst fehlte dem neuen
 * Sprint die Arbeit des vorigen. Ohne Remote oder bei eigenen lokalen Commits bleibt es beim lokalen main.
 */
export async function freshestMain(git: GitHelpers['git']): Promise<string> {
  if (!(await git('remote')).output.split('\n').includes('origin')) return MAIN_BRANCH;
  await git('fetch', '-q', 'origin', MAIN_BRANCH);
  const remote = `refs/remotes/origin/${MAIN_BRANCH}`;
  if ((await git('rev-parse', '--verify', '--quiet', remote)).exitCode !== 0) return MAIN_BRANCH;
  const behindOnly = (await git('merge-base', '--is-ancestor', MAIN_BRANCH, remote)).exitCode === 0;
  return behindOnly ? remote : MAIN_BRANCH;
}

/**
 * Den Sprint-Branch laufend auf dem Stand von main halten (vor jedem neuen Auftrag des Sprints). Früher kam main erst
 * beim Abschluss hinein – bis dahin hatten sich Korrekturen, PR-Merges und Doku auf main angesammelt und prallten
 * auf einmal aufeinander („main lässt sich nicht konfliktfrei übernehmen“). Ohne Konflikt wird gemergt; mit Konflikt
 * bleibt der Sprint-Branch wie er war (der Auftrag läuft weiter), und die Meldung steht im Log.
 */
export async function refreshSprintFromMain(git: GitHelpers['git'], branch: string): Promise<string | null> {
  if (!(await branchExists(git, MAIN_BRANCH))) return null;
  const main = await freshestMain(git);
  if ((await git('merge-base', '--is-ancestor', main, 'HEAD')).exitCode === 0) return null;
  const merged = await git('merge', '--no-edit', main, '-m', `Merge ${MAIN_BRANCH} in ${branch}`);
  if (merged.exitCode === 0) return `Aktuellen ${MAIN_BRANCH} in ${branch} übernommen.`;
  await git('merge', '--abort');
  const message = `${MAIN_BRANCH} lässt sich gerade nicht konfliktfrei in ${branch} übernehmen – der Sprint läuft weiter, beim Abschluss muss zusammengeführt werden.`;
  console.warn(message);
  return message;
}

/**
 * Wechselt vor der Arbeit an einem Sprint-Auftrag auf den Sprint-Branch (legt ihn bei Bedarf von main an).
 * Ungespeicherte Änderungen wandern mit; scheitert der Wechsel, bleibt der aktuelle Branch und es wird geloggt.
 */
export async function checkoutSprintBranch(
  cwd: string,
  sprint: SprintRef | string,
  rawExecute: CommandExecutor = runCommand,
): Promise<string | null> {
  const execute: CommandExecutor = (command, directory, options) =>
    withProjectLock(cwd, () => rawExecute(command, directory, options));
  const { git, must } = gitHelpers(execute, cwd);
  const branch = sprintBranchOf(sprint);
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

/**
 * Interne Ordner, die nie als geänderte Datei eines Auftrags zählen (Agent-Ablage, Berichte der Agents). Präfixe mit
 * Schrägstrich am Ende: docs/risiken-x/ oder docs/tests-extra/ bleiben fremd.
 */
export const CHANGED_FILES_IGNORED = ['.dev-log/', ...REPORT_DIRECTORIES];

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

/**
 * Geänderte versionierte Dateien, ohne Testberichte und Agent-Ablage (CHANGED_FILES_IGNORED). Auftrags-Commits nehmen
 * diese Pfade bewusst nicht mit (die Sprint-Sicherung tut es) – zählten sie hier, sperrte ein neu geschriebener
 * Testbericht jede Freigabe („Offene Änderungen im Arbeitsordner“).
 */
export async function trackedChanges(git: GitHelpers['git']): Promise<string[]> {
  const status = await git('-c', 'core.quotePath=false', 'status', '--porcelain', '--untracked-files=no');
  if (status.exitCode !== 0) return ['(git status fehlgeschlagen)'];
  return status.output
    .split('\n')
    .filter(Boolean)
    .map(porcelainPath)
    .filter((path) => path && !CHANGED_FILES_IGNORED.some((prefix) => path.startsWith(prefix)));
}
