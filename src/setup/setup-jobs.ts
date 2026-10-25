import { logged } from '../core/log.js';
import { existsSync } from 'node:fs';
import { lstat, mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import type { Pool } from 'pg';
import { DEFAULT_OLLAMA_URL, resolveModel } from '../agent/ollama-client.js';
import { type CommandExecutor, redactOutput, runCommand } from '../core/command.js';
import { commitProjectSetup, isValidGitRemote, pushRemote } from '../runner/git-sync.js';
import { gitEnvironment } from '../runner/project-command.js';
import { normalizeFolder, projectFolderError } from '../core/validation.js';
import { findTemplate } from './templates.js';
import { listFolders } from './folders.js';

/** Aufgaben, die der Worker auf dem Rechner ausführt (der Server im Container sieht keine Projektordner). */
export const SETUP_JOB_KINDS = [
  'check_folder',
  'create_folder',
  'check_github',
  'apply_template',
  'git_setup',
  'test_agent',
  'helper_chat',
  'list_folders',
  'check_chromium',
  'install_chromium',
] as const;
export type SetupJobKind = (typeof SETUP_JOB_KINDS)[number];

const STEP_TIMEOUT_MS = 10 * 60_000;
const QUICK_TIMEOUT_MS = 20_000;
const AGENT_TIMEOUT_MS = 120_000;

type Params = Record<string, unknown>;
type Log = (line: string) => Promise<void>;

const text = (value: unknown, max = 500): string => (typeof value === 'string' ? value.trim().slice(0, max) : '');

function folderOf(params: Params): string {
  const folder = text(params.path);
  const error = projectFolderError(folder);
  if (error) throw new Error(error);
  return normalizeFolder(folder) ?? folder;
}

const GIT_OPTIONS = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new',
};

const ENV = {
  ...process.env,
  ...GIT_OPTIONS,
  CI: '1',
  npm_config_yes: 'true',
};

/** git und gh (startet git, z. B. bei „repo create --push“): gefiltert und ohne Hooks des Projekts. */
const usesGit = (command: readonly string[]): boolean => command[0] === 'git' || command[0] === 'gh';

async function run(
  execute: CommandExecutor,
  command: string[],
  cwd: string,
  timeoutMs = QUICK_TIMEOUT_MS,
): Promise<{ ok: boolean; output: string }> {
  const env = usesGit(command) ? gitEnvironment({ ...GIT_OPTIONS, GH_PROMPT_DISABLED: '1' }) : ENV;
  const result = await execute(command, cwd, { timeoutMs, env }).catch((error: unknown) => ({
    exitCode: 1,
    durationMs: 0,
    output: error instanceof Error ? error.message : String(error),
  }));
  return { ok: result.exitCode === 0, output: redactOutput(result.output, process.env).trim() };
}

/** Befehl, der den Pfad eines Programms ausgibt: `where` unter Windows (kein /bin/sh), sonst `command -v`. */
export function whichCommand(binary: string, platform: NodeJS.Platform = process.platform): string[] {
  return platform === 'win32' ? ['where', binary] : ['/bin/sh', '-c', `command -v ${binary}`];
}

async function which(execute: CommandExecutor, binary: string): Promise<string | null> {
  const result = await run(execute, whichCommand(binary), process.cwd());
  return result.ok && result.output ? result.output.split(/\r?\n/)[0]! : null;
}

/** Ordner, Leere und Git-Zustand (Branch, Remote, Commits). */
async function checkFolder(params: Params, execute: CommandExecutor) {
  const folder = folderOf(params);
  const info = await stat(folder).catch(() => null);
  if (!info) return { exists: false, isDirectory: false, empty: true, git: null };
  if (!info.isDirectory()) return { exists: true, isDirectory: false, empty: false, git: null };
  const entries = (await readdir(folder)).filter((entry) => entry !== '.DS_Store');
  const isRepo = existsSync(join(folder, '.git'));
  let git: { isRepo: boolean; branch: string | null; remote: string | null; commits: number } | null = {
    isRepo,
    branch: null,
    remote: null,
    commits: 0,
  };
  if (isRepo) {
    const branch = await run(execute, ['git', 'rev-parse', '--abbrev-ref', 'HEAD'], folder);
    const remote = await run(execute, ['git', 'remote', 'get-url', 'origin'], folder);
    const commits = await run(execute, ['git', 'rev-list', '--count', 'HEAD'], folder);
    git = {
      isRepo,
      branch: branch.ok ? branch.output : null,
      remote: remote.ok ? remote.output : null,
      commits: commits.ok ? Number(commits.output) || 0 : 0,
    };
  }
  return {
    exists: true,
    isDirectory: true,
    empty: entries.filter((entry) => entry !== '.git').length === 0,
    entries: entries.slice(0, 12),
    git,
  };
}

async function createFolder(params: Params) {
  const folder = folderOf(params);
  await mkdir(folder, { recursive: true });
  return { created: true, path: folder };
}

/**
 * Projektordner löschen (nur intern über DELETE /api/projects, der Pfad stammt aus der Datenbank).
 * Mehrfach abgesichert: gültiger Projektordner, mindestens drei Ebenen tief, kein symbolischer Link, nicht AIdeation.
 */
export async function deleteProjectFolder(params: Params) {
  const folder = resolve(folderOf(params));
  const depth = folder.split(sep).filter(Boolean).length;
  if (depth < 3) throw new Error(`Ordner ${folder} liegt zu weit oben und wird nicht gelöscht.`);
  const devLog = resolve(import.meta.dirname, '..', '..');
  if (folder === devLog || devLog.startsWith(folder + sep) || folder.startsWith(devLog + sep)) {
    throw new Error('Der AIdeation-Ordner selbst wird nie gelöscht.');
  }
  const info = await lstat(folder).catch(() => null);
  if (!info) return { deleted: false, path: folder, reason: 'Ordner existiert nicht (mehr).' };
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`${folder} ist kein normaler Ordner.`);
  await rm(folder, { recursive: true, force: false });
  return { deleted: true, path: folder };
}

/** GitHub-Verbindung: gh CLI (Anmeldung) und SSH-Schlüssel. */
async function checkGithub(execute: CommandExecutor) {
  const gh = await which(execute, 'gh');
  let ghUser: string | null = null;
  let ghAuthenticated = false;
  if (gh) {
    const status = await run(execute, ['gh', 'auth', 'status', '--hostname', 'github.com'], process.cwd());
    ghAuthenticated = status.ok;
    ghUser = /account (\S+)/.exec(status.output)?.[1] ?? /as (\S+)/.exec(status.output)?.[1] ?? null;
  }
  const ssh = await run(
    execute,
    [
      'ssh',
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=8',
      '-o',
      'StrictHostKeyChecking=accept-new',
      '-T',
      'git@github.com',
    ],
    process.cwd(),
  );
  const sshUser = /Hi ([^!]+)!/.exec(ssh.output)?.[1] ?? null;
  return {
    gh: { installed: Boolean(gh), authenticated: ghAuthenticated, user: ghUser },
    ssh: { ok: Boolean(sshUser), user: sshUser, message: sshUser ? null : ssh.output.slice(0, 300) },
  };
}

/** Wendet eine Vorlage im leeren Ordner an: Dateien schreiben, dann Generatoren/Installationen ausführen. */
async function applyTemplate(params: Params, execute: CommandExecutor, log: Log) {
  const folder = folderOf(params);
  const template = findTemplate(text(params.template, 60));
  if (!template) throw new Error('Unbekannte Vorlage.');
  const name = text(params.name, 120) || 'Projekt';
  await mkdir(folder, { recursive: true });
  const entries = (await readdir(folder)).filter((entry) => !['.DS_Store', '.git'].includes(entry));
  if (entries.length) throw new Error('Der Ordner ist nicht leer – eine Vorlage braucht einen leeren Ordner.');
  if (template.id === 'custom') {
    const url = text(params.templateUrl);
    if (!isValidGitRemote(url)) throw new Error('Bitte eine gültige Git-URL der Vorlage angeben.');
    const temp = join(folder, '.devlog-template');
    await log(`Klone Vorlage ${url} …`);
    const clone = await run(execute, ['git', 'clone', '--depth', '1', url, temp], folder, STEP_TIMEOUT_MS);
    if (!clone.ok) throw new Error(`Klonen fehlgeschlagen: ${clone.output.slice(-400)}`);
    await rm(join(temp, '.git'), { recursive: true, force: true });
    // Ohne Shell (gibt es unter Windows nicht): Einträge verschieben, der Ordner ist bis auf .git leer.
    for (const entry of await readdir(temp)) await rename(join(temp, entry), join(folder, entry));
    await rm(temp, { recursive: true, force: true });
    await log('Vorlage übernommen (ohne fremde Git-Historie).');
    return { template: template.id };
  }
  for (const file of template.files?.(name) ?? []) {
    const target = join(folder, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.content);
  }
  if (template.files) await log('Dateien der Vorlage geschrieben.');
  for (const command of template.commands ?? []) {
    await log(`$ ${command.join(' ')}`);
    const result = await run(execute, command, folder, STEP_TIMEOUT_MS);
    await log(result.output.split('\n').slice(-6).join('\n'));
    if (!result.ok) throw new Error(`\`${command.join(' ')}\` ist fehlgeschlagen.`);
  }
  return { template: template.id };
}

/** Git einrichten: init + Initial-Commit, optional GitHub-Repo anlegen (gh) oder vorhandenes verbinden und pushen. */
async function gitSetup(params: Params, execute: CommandExecutor, log: Log) {
  const folder = folderOf(params);
  const mode = text(params.mode, 20);
  if (mode === 'none') return { mode, remote: null };
  const git = async (...args: string[]) => {
    const result = await run(execute, ['git', ...args], folder, STEP_TIMEOUT_MS);
    if (!result.ok) throw new Error(`git ${args[0]} fehlgeschlagen: ${result.output.slice(-400)}`);
    return result.output;
  };
  // Wie bei den Auftrags-Commits: .env, Schlüssel und interne Ordner bleiben draussen, bevor gepusht wird.
  const setup = await commitProjectSetup(folder, execute);
  if (setup.initialized) await log('Git-Repository angelegt (Branch main).');
  if (setup.held.length) {
    await log(`Nicht committet, weil sie nach Zugangsdaten aussehen: ${setup.held.join(', ')}`);
  }
  if (setup.committed) await log('Commit erstellt.');
  let remote: string | null = null;
  if (mode === 'github-new') {
    const name = text(params.repoName, 100);
    if (!/^[\w.-]+(\/[\w.-]+)?$/.test(name)) throw new Error('Ungültiger Repository-Name.');
    const visibility = params.visibility === 'public' ? '--public' : '--private';
    await log(`Lege GitHub-Repository ${name} an und pushe …`);
    const created = await run(
      execute,
      ['gh', 'repo', 'create', name, visibility, '--source', '.', '--remote', 'origin', '--push'],
      folder,
      STEP_TIMEOUT_MS,
    );
    if (!created.ok) throw new Error(`gh repo create fehlgeschlagen: ${created.output.slice(-400)}`);
    remote = (await run(execute, ['git', 'remote', 'get-url', 'origin'], folder)).output || null;
  } else if (mode === 'github-existing') {
    const url = text(params.remote);
    if (!isValidGitRemote(url)) throw new Error('Bitte eine gültige GitHub-URL ohne Zugangsdaten angeben.');
    const target = pushRemote(url);
    const current = await run(execute, ['git', 'remote', 'get-url', 'origin'], folder);
    await git(...(current.ok ? ['remote', 'set-url', 'origin', target] : ['remote', 'add', 'origin', target]));
    const branch = await git('rev-parse', '--abbrev-ref', 'HEAD');
    await log(`Pushe ${branch} nach ${url} …`);
    await git('push', '-u', 'origin', branch);
    remote = url;
  }
  await log(mode === 'local' ? 'Lokales Repository bereit.' : 'Mit GitHub verbunden und gepusht.');
  return { mode, remote };
}

const AGENT_COMMANDS: Record<string, (model: string) => string[]> = {
  claude: (model) => ['claude', '--model', model || 'haiku', '-p', 'Antworte nur mit dem Wort OK.'],
  copilot: () => ['copilot', '-p', 'Antworte nur mit dem Wort OK.'],
  gemini: (model) => ['gemini', ...(model ? ['-m', model] : []), '-p', 'Antworte nur mit dem Wort OK.'],
};

/** Prüft, ob ein Agent-Anbieter installiert und angemeldet ist, mit einer kurzen Testfrage. */
async function testAgent(params: Params, execute: CommandExecutor) {
  const provider = text(params.provider, 20);
  const model = text(params.model, 80);
  if (provider === 'ollama') {
    const base = (process.env.DEV_LOG_OLLAMA_URL ?? DEFAULT_OLLAMA_URL).replace(/\/$/, '');
    const response = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(5000) }).catch(() => null);
    if (!response?.ok) return { installed: Boolean(await which(execute, 'ollama')), ok: false, models: [] };
    const models = (((await response.json()) as { models?: { name: string }[] }).models ?? []).map(
      (entry) => entry.name,
    );
    const wanted = model || resolveModel('assistant');
    return { installed: true, ok: models.includes(wanted), models, model: wanted };
  }
  const build = AGENT_COMMANDS[provider];
  if (!build) throw new Error('Unbekannter Anbieter.');
  if (!(await which(execute, provider))) return { installed: false, ok: false };
  const result = await run(execute, build(model), process.cwd(), AGENT_TIMEOUT_MS);
  return { installed: true, ok: result.ok && /ok/i.test(result.output), output: result.output.slice(-400) };
}

const HELPER_PROMPT = `Du bist der kostenlose Hilfe-Assistent im Einrichtungsassistenten von AIdeation. AIdeation verwaltet Software-Projekte mit KI-Agents (Auftragsautor, Entwickler, Tester, Dokumentierer) und Git-Sprints. Der Nutzer legt gerade ein Projekt an: 1) Ordner wählen, 2) Git/GitHub und Vorlage, 3) Agent-Anbieter (lokal Ollama oder bezahlt: Claude, Copilot, Gemini), 4) Rechte der Agents. Antworte kurz, konkret und auf Deutsch, mit Befehlen für macOS (Terminal) wo hilfreich.

Verlässliche Fakten (nutze genau diese Befehle, erfinde keine anderen):
- GitHub CLI: \`brew install gh\`, dann \`gh auth login\` (GitHub.com, SSH, im Browser bestätigen). Ohne gh kann ein vorhandenes Repository per SSH verbunden werden; Test: \`ssh -T git@github.com\`.
- Claude Code: \`curl -fsSL https://claude.ai/install.sh | bash\`, danach \`claude\` starten und \`/login\` (Claude-Abo oder API-Schlüssel).
- GitHub Copilot CLI: \`npm install -g @github/copilot\`, danach \`copilot\` starten und \`/login\` (Copilot-Abo nötig).
- Gemini CLI (offiziell von Google): \`npm install -g @google/gemini-cli\`, danach \`gemini\` starten und mit Google anmelden.
- Ollama (lokal, kostenlos): \`brew install ollama\` oder App von ollama.com, dann \`ollama serve\` und \`ollama pull <modell>\`.
- Wenn du etwas nicht sicher weißt, sage das ehrlich.`;

/** Kurze Antwort des lokalen Modells (Ollama) für Fragen während der Einrichtung. */
async function helperChat(params: Params) {
  const messages = Array.isArray(params.messages) ? params.messages.slice(-10) : [];
  const step = text(params.step, 200);
  const base = (process.env.DEV_LOG_OLLAMA_URL ?? DEFAULT_OLLAMA_URL).replace(/\/$/, '');
  const response = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(AGENT_TIMEOUT_MS),
    body: JSON.stringify({
      model: resolveModel('assistant'),
      stream: false,
      think: false,
      messages: [
        { role: 'system', content: `${HELPER_PROMPT}${step ? `\nAktueller Schritt: ${step}` : ''}` },
        ...messages
          .filter((entry): entry is { role: string; content: string } => typeof entry === 'object' && entry !== null)
          .map((entry) => ({
            role: entry.role === 'assistant' ? 'assistant' : 'user',
            content: text(entry.content, 2000),
          })),
      ],
    }),
  }).catch(() => null);
  if (!response?.ok) {
    return { answer: 'Der lokale Hilfe-Assistent (Ollama) ist nicht erreichbar. Starte Ollama mit `ollama serve`.' };
  }
  const body = (await response.json()) as { message?: { content?: string } };
  return { answer: (body.message?.content ?? '').replace(/<think>[\s\S]*?<\/think>/g, '').trim() || '–' };
}

/** Chromium für die visuelle Prüfung: Playwright-Paket vorhanden und Browser heruntergeladen? */
export async function checkChromium(
  load: () => Promise<{ chromium: { executablePath(): string } }> = () => import('playwright'),
) {
  const playwright = await load().catch(() => null);
  if (!playwright) return { installed: false, playwright: false, command: CHROMIUM_INSTALL.join(' ') };
  const path = (() => {
    try {
      return playwright.chromium.executablePath();
    } catch {
      return '';
    }
  })();
  return { installed: Boolean(path) && existsSync(path), playwright: true, command: CHROMIUM_INSTALL.join(' ') };
}

/** Lädt Chromium mit der in AIdeation installierten Playwright-Version (npx ohne Nachladen fremder Pakete). */
const CHROMIUM_INSTALL = ['npx', '--no-install', 'playwright', 'install', 'chromium'];

async function installChromium(execute: CommandExecutor, log: Log) {
  await log(`$ ${CHROMIUM_INSTALL.join(' ')}`);
  const result = await run(execute, CHROMIUM_INSTALL, resolve(import.meta.dirname, '..', '..'), STEP_TIMEOUT_MS);
  await log(result.output.slice(-2000));
  if (!result.ok) throw new Error('Chromium konnte nicht installiert werden.');
  return checkChromium();
}

/** Arbeitet den ältesten offenen Einrichtungsjob ab; gibt false zurück, wenn keiner wartet. */
export async function processSetupJob(pool: Pool, execute: CommandExecutor = runCommand): Promise<boolean> {
  const job = (
    await pool.query<{ id: string; kind: SetupJobKind | 'delete_folder'; params: Params }>(
      `UPDATE setup_jobs SET status = 'running', updated_at = NOW()
        WHERE id = (SELECT id FROM setup_jobs WHERE status = 'pending' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
        RETURNING id, kind, params`,
    )
  ).rows[0];
  if (!job) return false;
  const log: Log = async (line) => {
    if (!line.trim()) return;
    await pool
      .query(`UPDATE setup_jobs SET log = right(log || $2 || E'\\n', 20000), updated_at = NOW() WHERE id = $1`, [
        job.id,
        line,
      ])
      .catch(logged('setup-jobs'));
  };
  try {
    const params = job.params ?? {};
    const result =
      job.kind === 'check_folder'
        ? await checkFolder(params, execute)
        : job.kind === 'create_folder'
          ? await createFolder(params)
          : job.kind === 'check_github'
            ? await checkGithub(execute)
            : job.kind === 'apply_template'
              ? await applyTemplate(params, execute, log)
              : job.kind === 'git_setup'
                ? await gitSetup(params, execute, log)
                : job.kind === 'test_agent'
                  ? await testAgent(params, execute)
                  : job.kind === 'delete_folder'
                    ? await deleteProjectFolder(params)
                    : job.kind === 'list_folders'
                      ? await listFolders(params.path)
                      : job.kind === 'check_chromium'
                        ? await checkChromium()
                        : job.kind === 'install_chromium'
                          ? await installChromium(execute, log)
                          : await helperChat(params);
    await pool.query(`UPDATE setup_jobs SET status = 'done', result = $2::jsonb, updated_at = NOW() WHERE id = $1`, [
      job.id,
      JSON.stringify(result),
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await log(message);
    await pool.query(`UPDATE setup_jobs SET status = 'failed', result = $2::jsonb, updated_at = NOW() WHERE id = $1`, [
      job.id,
      JSON.stringify({ error: message }),
    ]);
  }
  // Alte Jobs aufräumen.
  await pool.query(`DELETE FROM setup_jobs WHERE created_at < NOW() - INTERVAL '1 day'`).catch(logged('setup-jobs'));
  return true;
}
