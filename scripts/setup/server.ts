/**
 * Einrichtungs-Assistent für AIdeation (läuft vor dem ersten Start, nur auf 127.0.0.1).
 * Prüft das System, schreibt die .env, startet Docker, richtet den Worker ein und öffnet danach die App.
 * Aufruf über start.sh / start.cmd – nicht direkt nötig.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { platform } from 'node:os';
import { join, resolve } from 'node:path';
import pg from 'pg';
import {
  DEFAULT_DB_USER,
  type EnvPlan,
  type InstallInput,
  validateInstall,
  writeEnvFile,
} from '../../src/core/env-file.js';
import { projectRoots } from '../../src/core/validation.js';
import { MIN_NODE, nodeVersionOk, prepareGameTools } from '../../src/setup/game-tools.js';
import { checkChromium } from '../../src/setup/setup-jobs.js';
import { installDemoProject } from './demo-data.js';

const ROOT = join(import.meta.dirname, '..', '..');
const ENV_FILE = join(ROOT, '.env');
const PORT = Number(process.env.DEV_LOG_SETUP_PORT ?? 3999);
const TOKEN = randomBytes(18).toString('base64url');
const APP_URL = 'http://localhost:3100';
const IS_WINDOWS = platform() === 'win32';
let installing = false;
let dbPasswordPending = false;

function run(
  command: string,
  args: string[],
  onLine?: (line: string) => void,
  timeoutMs = 20 * 60_000,
  input?: string,
): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    let output = '';
    const child = spawn(command, args, { cwd: ROOT, shell: IS_WINDOWS, env: process.env });
    child.stdin.on('error', () => undefined);
    child.stdin.end(input ?? '');
    const timer = setTimeout(() => child.kill(), timeoutMs);
    const collect = (chunk: Buffer): void => {
      const text = chunk.toString();
      output += text;
      for (const line of text.split(/\r?\n/)) if (line.trim()) onLine?.(line.slice(0, 400));
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, output: error.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, output: output.trim() });
    });
  });
}

async function version(command: string, args: string[]): Promise<string | null> {
  const result = await run(command, args, undefined, 15_000);
  return result.ok ? result.output.split('\n')[0]!.trim().slice(0, 120) : null;
}

async function checks() {
  const [docker, compose, git, claude, ollama, chromium] = await Promise.all([
    version('docker', ['version', '--format', '{{.Server.Version}}']),
    version('docker', ['compose', 'version', '--short']),
    version('git', ['--version']),
    version('claude', ['--version']),
    version('ollama', ['--version']),
    checkChromium(),
  ]);
  return {
    platform: platform(),
    node: {
      ok: nodeVersionOk(process.versions.node),
      version: process.versions.node,
      min: `${MIN_NODE.major}.${MIN_NODE.minor}`,
    },
    // Chromium für Playwright: Smoke-Test der Phaser-Vorlage und optische Abnahme; fehlt er, lädt ihn die Installation.
    chromium: { ok: chromium.installed },
    docker: { ok: Boolean(docker), version: docker },
    compose: { ok: Boolean(compose), version: compose },
    git: { ok: Boolean(git), version: git },
    claude: { ok: Boolean(claude), version: claude },
    ollama: { ok: Boolean(ollama), version: ollama },
    envExists: existsSync(ENV_FILE),
    // Vorschlag für den Projektbereich: der Ordner, in dem AIdeation liegt.
    defaultProjectRoot: resolve(ROOT, '..'),
  };
}

/** Schreibt die .env zusammengeführt (Logik in src/core/env-file.ts); Schlüssel und Passwörter nie ins Protokoll. */
async function writeEnv(body: InstallInput, log: (line: string) => void): Promise<EnvPlan> {
  const result = await writeEnvFile(ENV_FILE, body);
  if (result.backup) log(`Bisherige .env gesichert: ${result.backup}`);
  if (result.secretKeyCreated)
    log('Neuer Secret Key (DEV_LOG_SECRET_KEY) erzeugt – bitte die .env sicher aufbewahren.');
  if (result.dbPasswordCreated) log('Neues Datenbank-Passwort erzeugt.');
  log('Konfiguration (.env) geschrieben, bestehende Werte übernommen.');
  return result;
}

/**
 * Postgres übernimmt POSTGRES_PASSWORD nur beim ersten Anlegen der Datenbank. Wurde das DB-Passwort neu erzeugt,
 * kennt eine schon vorhandene Datenbank (früher mit dem Standard „devlog_local_dev“) es noch nicht. Im Container
 * gilt für den lokalen Socket „trust“, deshalb lässt sich das Passwort dort ohne das alte setzen.
 */
async function applyDbPassword(env: Map<string, string>, log: (line: string) => void): Promise<boolean> {
  const user = env.get('DEV_LOG_DB_USER') || DEFAULT_DB_USER;
  const password = env.get('DEV_LOG_DB_PASSWORD')!;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(user) || !/^[0-9a-f]+$/.test(password)) {
    log('Datenbank-Passwort nicht gesetzt: DEV_LOG_DB_USER oder DEV_LOG_DB_PASSWORD hat ein unerwartetes Format.');
    return false;
  }
  log('Starte die Datenbank und setze das neue Passwort …');
  const db = await run('docker', ['compose', 'up', '-d', '--wait', 'db'], log);
  if (!db.ok) return false;
  // Das Passwort geht über stdin, damit es weder im Protokoll noch in der Prozessliste steht.
  const sql = `ALTER USER "${user}" WITH PASSWORD '${password}';\n`;
  const psql = ['compose', 'exec', '-T', 'db', 'psql', '-v', 'ON_ERROR_STOP=1', '-U', user, '-d', 'aideation'];
  const alter = await run('docker', psql, log, 60_000, sql);
  return alter.ok;
}

async function waitForHealth(log: (line: string) => void): Promise<boolean> {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    try {
      const response = await fetch('http://127.0.0.1:3100/health', { signal: AbortSignal.timeout(2000) });
      if (response.ok) return true;
    } catch {
      // startet noch
    }
    if (attempt % 10 === 0) log('Warte auf AIdeation …');
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return false;
}

async function install(body: InstallInput, send: (event: Record<string, unknown>) => void): Promise<boolean> {
  const log = (line: string) => send({ type: 'log', line });
  const step = (id: string, status: 'running' | 'ok' | 'error' | 'skipped', note = '') =>
    send({ type: 'step', id, status, note });

  step('env', 'running');
  let plan: EnvPlan;
  try {
    plan = await writeEnv(body, log);
  } catch (error) {
    step('env', 'error', `Die .env konnte nicht geschrieben werden: ${(error as Error).message}`);
    send({ type: 'done', ok: false });
    return false;
  }
  const env = plan.values;
  step('env', 'ok');

  step('docker', 'running');
  // Ist das Setzen fehlgeschlagen, steht das neue Passwort schon in der .env – der nächste Versuch setzt es erneut.
  if (plan.dbPasswordCreated) dbPasswordPending = true;
  if (dbPasswordPending) {
    if (!(await applyDbPassword(env, log))) {
      step('docker', 'error', 'Das neue Datenbank-Passwort konnte nicht gesetzt werden – Details im Protokoll.');
      send({ type: 'done', ok: false });
      return false;
    }
    dbPasswordPending = false;
  }
  // Fehlt ./backups, legt Docker den Ordner unter Linux als root an – der Backup-Container (ohne root) kann dann nicht schreiben.
  await mkdir(join(ROOT, 'backups'), { recursive: true });
  log('Baue und starte die Container (beim ersten Mal einige Minuten) …');
  const up = await run('docker', ['compose', 'up', '-d', '--build'], log);
  if (!up.ok) {
    step('docker', 'error', 'docker compose up ist fehlgeschlagen – Details im Protokoll.');
    send({ type: 'done', ok: false });
    return false;
  }
  step('docker', 'ok');

  step('health', 'running');
  const healthy = await waitForHealth(log);
  step(
    'health',
    healthy ? 'ok' : 'error',
    healthy ? '' : 'AIdeation antwortet nicht – „docker compose logs dev-log“ zeigt den Grund.',
  );
  if (!healthy) {
    send({ type: 'done', ok: false });
    return false;
  }

  if (body.demoData) {
    step('demo', 'running');
    // Läuft auf diesem Rechner gegen die eben gestartete Datenbank (Port 5433), das Schema hat der Server angelegt.
    const pool = new pg.Pool({ connectionString: env.get('DEV_LOG_DATABASE_URL')!, max: 2 });
    const root = projectRoots({ DEV_LOG_PROJECT_ROOTS: env.get('DEV_LOG_PROJECT_ROOTS') })[0] ?? resolve(ROOT, '..');
    try {
      const result = await installDemoProject(pool, root, log);
      step('demo', 'ok', result === 'exists' ? 'War schon vorhanden.' : 'Velowerk angelegt, Sprint pausiert.');
    } catch (error) {
      // Kein Abbruch: AIdeation läuft auch ohne Beispieldaten.
      log(`Beispieldaten: ${(error as Error).message}`);
      step('demo', 'error', 'Beispieldaten konnten nicht angelegt werden – AIdeation läuft trotzdem.');
    } finally {
      await pool.end().catch(() => undefined);
    }
  } else {
    step('demo', 'skipped', 'Ohne Beispieldaten – du startest mit einem leeren AIdeation.');
  }

  // Spiele-Werkzeuge (Phaser-Vorlage): Chromium und npm-Pakete vorladen. Kein Abbruch, AIdeation läuft auch ohne.
  step('game', 'running');
  const tools = await prepareGameTools((command, args) => run(command, args, log), log);
  step('game', tools.notes.length ? 'error' : 'ok', tools.notes.join(' '));

  if (!body.installWorker) {
    step('worker', 'skipped', 'Den Worker startest du später mit „npm run worker“.');
  } else {
    step('worker', 'running');
    // Die Installationsskripte (launchd, systemd, Aufgabenplanung) lesen URL und Schlüssel aus der Umgebung.
    // PATH bleibt unverändert, sonst findet der Worker die Agent-CLIs nicht (spawn claude ENOENT).
    process.env.DEV_LOG_DATABASE_URL = env.get('DEV_LOG_DATABASE_URL')!;
    process.env.DEV_LOG_SECRET_KEY = env.get('DEV_LOG_SECRET_KEY')!;
    const os = platform();
    const result =
      os === 'darwin'
        ? await run('bash', ['scripts/install-worker.sh'], log)
        : os === 'win32'
          ? await run('powershell', ['-ExecutionPolicy', 'Bypass', '-File', 'scripts\\install-worker.ps1'], log)
          : await run('bash', ['scripts/install-worker-linux.sh'], log);
    step(
      'worker',
      result.ok ? 'ok' : 'error',
      result.ok ? '' : 'Worker konnte nicht eingerichtet werden – „npm run worker“ startet ihn von Hand.',
    );
    if (os === 'darwin') {
      const watchdog = await run('bash', ['scripts/install-watchdog.sh'], log);
      log(watchdog.ok ? 'Ausfall-Wächter eingerichtet.' : 'Ausfall-Wächter nicht eingerichtet (optional).');
    }
  }
  send({ type: 'done', ok: true, url: APP_URL });
  return true;
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
}

async function body(request: IncomingMessage): Promise<unknown> {
  let raw = '';
  for await (const chunk of request) {
    raw += chunk;
    if (raw.length > 20_000) throw new Error('Anfrage zu groß.');
  }
  return raw ? JSON.parse(raw) : {};
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://127.0.0.1:${PORT}`);
  try {
    if (request.method === 'GET' && url.pathname === '/') {
      const html = await readFile(join(import.meta.dirname, 'wizard.html'), 'utf8');
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy':
          "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:",
        'Cache-Control': 'no-store',
      });
      response.end(html);
      return;
    }
    // Alle API-Aufrufe verlangen den Schlüssel aus dem Startlink (Schutz vor fremden Webseiten im Browser).
    if (request.headers['x-setup-token'] !== TOKEN)
      return json(response, 403, { message: 'Ungültiger Schlüssel – bitte den Link aus dem Terminal öffnen.' });
    if (request.method === 'GET' && url.pathname === '/api/check') return json(response, 200, await checks());
    if (request.method === 'POST' && url.pathname === '/api/install') {
      // Sperre: zwei gleichzeitige Läufe würden die .env und die Container gegenseitig überschreiben.
      if (installing)
        return json(response, 409, { message: 'Die Einrichtung läuft bereits – bitte das andere Fenster abwarten.' });
      installing = true;
      try {
        const payload = (await body(request)) as Partial<InstallInput>;
        const problem = validateInstall(payload);
        if (problem) return json(response, 400, { message: problem });
        response.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' });
        const send = (event: Record<string, unknown>) => response.write(`${JSON.stringify(event)}\n`);
        const ok = await install(
          {
            username: payload.username!,
            password: payload.password!,
            domain: payload.domain ?? '',
            projectRoots: payload.projectRoots ?? '',
            installWorker: payload.installWorker !== false,
            demoData: payload.demoData === true,
          },
          send,
        ).catch((error: unknown) => {
          send({ type: 'log', line: `Fehler: ${(error as Error).message}` });
          send({ type: 'done', ok: false });
          return false;
        });
        response.end();
        // Nach einem Fehler bleibt der Assistent offen, damit ein neuer Versuch möglich ist.
        if (ok) setTimeout(() => process.exit(0), 3000);
        return;
      } finally {
        installing = false;
      }
    }
    json(response, 404, { message: 'Nicht gefunden.' });
  } catch (error) {
    if (!response.headersSent) json(response, 500, { message: (error as Error).message });
    else response.end();
  }
});

server.listen(PORT, '127.0.0.1', () => {
  const link = `http://127.0.0.1:${PORT}/#${TOKEN}`;
  console.log(`\n  AIdeation – Einrichtung: ${link}\n`);
  if (process.env.DEV_LOG_SETUP_NO_BROWSER) return;
  const opener = IS_WINDOWS
    ? ['cmd', ['/c', 'start', '', link]]
    : platform() === 'darwin'
      ? ['open', [link]]
      : ['xdg-open', [link]];
  spawn(opener[0] as string, opener[1] as string[], { stdio: 'ignore', detached: true })
    .on('error', () => undefined)
    .unref();
});
