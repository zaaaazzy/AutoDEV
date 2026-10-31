import { execFile } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Prüfung vor jedem Git-Aufruf des Workers im Projekt. Agents schreiben in den Arbeitsordner und damit in `.git`
 * (eigener Ordner im Live-Ordner, Datei „gitdir: …“ in einem Worktree). Hooks und fsmonitor schaltet gitEnvironment
 * ab, aber Git führt noch viel mehr aus der Repo-Konfiguration aus: `filter.<name>.clean` bei `add`/`status`,
 * `credential.helper=!…` und `core.sshCommand` beim Push, `gpg.program`, `diff.<name>.textconv`, Merge-Treiber,
 * `include.path` auf eine eigene Datei. Ein umgebogenes `gitdir: .x` brächte eine beliebige eigene Konfiguration mit.
 *
 * Darum: Git-Ordner per `rev-parse` bestimmen, Umlenkung in den Arbeitsordner ablehnen, die Repo-Konfiguration gegen
 * eine Positivliste prüfen (alles Unbekannte ist abgelehnt) und den geprüften Git-Ordner per GIT_DIR/GIT_WORK_TREE
 * festhalten, damit Git die `.git`-Datei nicht erneut liest. Im Worktree liegt die Konfiguration im Haupt-Checkout,
 * ausserhalb der Reichweite des Agents. Arbeitet der Agent direkt im Live-Ordner, bleibt ein Zeitfenster zwischen
 * Prüfung und Aufruf; das schliesst erst ein schreibgeschütztes `.git` im Container.
 */

/** Setzt gitEnvironment: nur solche Aufrufe prüft runCommand (Git des Workers auf Projekten). */
export const GIT_GUARD_ENV = 'DEV_LOG_GIT_GUARD';

/** Arbeiten ohne bestehendes Repository (klonen, anlegen, Remote abfragen): nichts zu prüfen. */
const WITHOUT_REPOSITORY = new Set(['clone', 'init', 'ls-remote', 'version', '--version']);

const SAFE_KEYS: readonly RegExp[] = [
  // core.hooksPath und core.fsmonitor setzt gitEnvironment per GIT_CONFIG_* ausser Kraft.
  /^core\.(repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode|symlinks|autocrlf|safecrlf|eol|quotepath|checkstat|trustctime|untrackedcache|splitindex|sparsecheckout|sparsecheckoutcone|longpaths|fscache|commitgraph|multipackindex|preloadindex|hookspath|fsmonitor)$/,
  /^extensions\.[a-z]+$/,
  /^remote\..+\.(fetch|push|prune|prunetags|tagopt|mirror|skipdefaultupdate)$/,
  /^branch\..+\.[a-z-]+$/,
  /^submodule\..+\.(active|branch)$/,
  /^user\.(name|email)$/,
  /^(pull\.(rebase|ff)|push\.(default|autosetupremote)|fetch\.(prune|prunetags)|init\.defaultbranch)$/,
  /^(merge\.(ff|conflictstyle)|rebase\.(autostash|autosquash)|rerere\.enabled|http\.postbuffer)$/,
  /^(gc|index|feature|advice|color|gui|lfs)\.[a-z]+$/,
  /^maintenance\.(auto|strategy)$/,
];

/** Adressen: GitHub o. ä. per HTTPS/SSH oder ein lokaler Pfad (Tests, Spiegel); keine Transport-Helfer (`ext::`). */
const URL_KEY = /^(remote|submodule)\..+\.(url|pushurl)$/;
const REMOTE_URL = /^(https:\/\/[^\s@/]+\/\S+|git@[A-Za-z0-9.-]+:\S+|ssh:\/\/git@\S+)$/;

/** git-lfs trägt sich mit genau diesen Befehlen ein (`git lfs install --local`). */
const LFS_FILTER: Readonly<Record<string, string>> = {
  'filter.lfs.clean': 'git-lfs clean -- %f',
  'filter.lfs.smudge': 'git-lfs smudge -- %f',
  'filter.lfs.process': 'git-lfs filter-process',
  'filter.lfs.required': 'true',
};

/** Begründung, warum ein Eintrag der Repo-Konfiguration nicht erlaubt ist; null, wenn er unbedenklich ist. */
export function unsafeConfigEntry(key: string, value: string): string | null {
  if (key in LFS_FILTER) return LFS_FILTER[key] === value ? null : `${key} = ${value}`;
  if (URL_KEY.test(key)) {
    const local = isAbsolute(value) && !value.includes('::');
    return value.length <= 300 && (REMOTE_URL.test(value) || local) ? null : `${key} = ${value}`;
  }
  return SAFE_KEYS.some((pattern) => pattern.test(key)) ? null : key;
}

/** Git-Befehl ohne vorangestellte Optionen (`-c k=v`, `--no-pager` …). */
export function gitSubcommand(args: readonly string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '-c' || arg === '-C') index += 1;
    else if (arg === '--version' || !arg.startsWith('-')) return arg;
  }
  return undefined;
}

async function git(args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, env, timeout: 15_000, maxBuffer: 4 * 1024 * 1024 });
  return stdout;
}

const exists = (path: string): Promise<boolean> =>
  lstat(path).then(
    () => true,
    () => false,
  );

const inside = (root: string, path: string): boolean => path === root || path.startsWith(root + sep);

async function configProblem(file: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  if (!(await exists(file))) return null;
  // --file liest genau diese Datei, ohne include.path zu folgen; die Einträge sind „Schlüssel\nWert\0“.
  const listed = await git(['config', '--file', file, '--null', '--list'], '/', env);
  for (const entry of listed.split('\0')) {
    if (!entry) continue;
    const newline = entry.indexOf('\n');
    const key = newline < 0 ? entry : entry.slice(0, newline);
    const problem = unsafeConfigEntry(key, newline < 0 ? '' : entry.slice(newline + 1));
    if (problem) return `${file}: ${problem}`;
  }
  return null;
}

export type GitGuardResult = { env: NodeJS.ProcessEnv } | { refused: string };

/**
 * Prüft das Repository, in dem `git <args>` in `cwd` liefe. Liefert die Umgebung mit festgehaltenem GIT_DIR und
 * GIT_WORK_TREE oder den Grund der Ablehnung.
 */
export async function guardGitCall(
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<GitGuardResult> {
  // Nur der hier geprüfte Git-Ordner zählt, nie einer aus der Umgebung des Aufrufers.
  const base = Object.fromEntries(
    Object.entries(env).filter(([key]) => !['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR'].includes(key)),
  );
  let gitDir: string;
  let commonDir: string;
  let workTree: string;
  try {
    const [absolute, common, top] = (
      await git(['rev-parse', '--absolute-git-dir', '--git-common-dir', '--show-toplevel'], cwd, base)
    )
      .trim()
      .split('\n');
    if (!absolute || !common || !top) throw new Error('unvollständige Antwort von git rev-parse');
    gitDir = await realpath(absolute);
    commonDir = await realpath(resolve(cwd, common));
    workTree = await realpath(top);
  } catch (error) {
    if (WITHOUT_REPOSITORY.has(gitSubcommand(args) ?? '')) return { env: base };
    const detail = (error as { stderr?: string }).stderr?.trim() || (error as Error).message;
    return { refused: `Git-Aufruf verweigert: kein prüfbares Repository in ${cwd} (${detail})\n` };
  }
  // Ein Git-Ordner im Arbeitsordner ist nur als dessen eigenes .git normal; „gitdir: .x“ hat ein Agent angelegt.
  const ownGitDir = join(workTree, '.git');
  for (const dir of new Set([gitDir, commonDir])) {
    if (inside(workTree, dir) && !inside(ownGitDir, dir)) {
      return { refused: `Git-Aufruf verweigert: Git-Ordner ${dir} liegt im Arbeitsordner ${workTree}\n` };
    }
  }
  const files = new Set([gitDir, commonDir].flatMap((dir) => [join(dir, 'config'), join(dir, 'config.worktree')]));
  for (const file of files) {
    let problem: string | null;
    try {
      problem = await configProblem(file, base);
    } catch (error) {
      problem = `${file}: nicht lesbar (${(error as Error).message})`;
    }
    if (problem) {
      return {
        refused: `Git-Aufruf verweigert: Die Repo-Konfiguration enthält einen Eintrag, den Git ausführen könnte oder den AIdeation nicht kennt – ${problem}. Eintrag prüfen und entfernen.\n`,
      };
    }
  }
  return { env: { ...base, GIT_DIR: gitDir, GIT_WORK_TREE: workTree } };
}
