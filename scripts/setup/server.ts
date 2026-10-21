/**
 * Einrichtungs-Assistent für AIdeation (läuft vor dem ersten Start, nur auf 127.0.0.1).
 * Prüft das System, schreibt die .env, startet Docker, richtet den Worker ein und öffnet danach die App.
 * Aufruf über start.sh / start.cmd – nicht direkt nötig.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { platform } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');
const ENV_FILE = join(ROOT, '.env');
const PORT = Number(process.env.DEV_LOG_SETUP_PORT ?? 3999);
const TOKEN = randomBytes(18).toString('base64url');
const APP_URL = 'http://localhost:3100';
const IS_WINDOWS = platform() === 'win32';

function run(
  command: string,
  args: string[],
  onLine?: (line: string) => void,
  timeoutMs = 20 * 60_000,
): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    let output = '';
    const child = spawn(command, args, { cwd: ROOT, shell: IS_WINDOWS, env: process.env });
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
  const [docker, compose, git, claude, ollama] = await Promise.all([
    version('docker', ['version', '--format', '{{.Server.Version}}']),
    version('docker', ['compose', 'version', '--short']),
    version('git', ['--version']),
    version('claude', ['--version']),
    version('ollama', ['--version']),
  ]);
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  return {
    platform: platform(),
    node: { ok: nodeMajor >= 22, version: process.versions.node },
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

async function readEnv(): Promise<Map<string, string>> {
  const values = new Map<string, string>();
  if (!existsSync(ENV_FILE)) return values;
  for (const line of (await readFile(ENV_FILE, 'utf8')).split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match) values.set(match[1]!, match[2]!);
  }
  return values;
}

interface InstallRequest {
  username: string;
  password: string;
  domain: string;
  projectRoots: string;
  installWorker: boolean;
}

function validate(body: Partial<InstallRequest>): string | null {
  if (!/^[a-zA-Z0-9._-]{3,40}$/.test(body.username ?? ''))
    return 'Benutzername: 3–40 Zeichen (Buchstaben, Ziffern, . _ -).';
  if ((body.password ?? '').length < 16) return 'Das Passwort braucht mindestens 16 Zeichen.';
  if (/[\s#"'$`\\]/.test(body.password ?? ''))
    return 'Bitte im Passwort keine Leerzeichen, Anführungszeichen, # $ ` oder \\ verwenden.';
  if (body.domain && !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(body.domain))
    return 'Die Domain sieht ungültig aus (z. B. devlog.example.com).';
  return null;
}

/** Schreibt die .env (vorhandene wird gesichert, Datenbank-Passwort bleibt erhalten). */
async function writeEnv(body: InstallRequest, log: (line: string) => void): Promise<Map<string, string>> {
  const current = await readEnv();
  if (existsSync(ENV_FILE)) {
    const backup = `${ENV_FILE}.bak-${Date.now()}`;
    await copyFile(ENV_FILE, backup);
    log(`Bisherige .env gesichert: ${backup}`);
  }
  const dbPassword =
    current.get('DEV_LOG_DB_PASSWORD') ?? (current.size ? 'devlog_local_dev' : randomBytes(18).toString('hex'));
  const values = new Map<string, string>([
    ['DEV_LOG_AUTH', 'on'],
    ['DEV_LOG_USERNAME', body.username],
    ['DEV_LOG_PASSWORD', body.password],
    ['DEV_LOG_DB_PASSWORD', dbPassword],
    ['DEV_LOG_DATABASE_URL', `postgresql://devlog:${dbPassword}@localhost:5433/aideation`],
  ]);
  if (body.projectRoots.trim()) values.set('DEV_LOG_PROJECT_ROOTS', body.projectRoots.trim());
  // Backup-Container läuft ohne root: unter Linux als eigener Benutzer, damit er in ./backups schreiben darf.
  if (platform() === 'linux' && process.getuid && process.getgid)
    values.set('DEV_LOG_BACKUP_USER', `${process.getuid()}:${process.getgid()}`);
  if (body.domain.trim()) {
    values.set('DEV_LOG_DOMAIN', body.domain.trim());
    values.set('DEV_LOG_PUBLIC_URL', `https://${body.domain.trim()}`);
    values.set('COMPOSE_PROFILES', 'https');
  }
  const content = [
    '# AIdeation – erzeugt vom Einrichtungs-Assistenten',
    ...[...values].map(([key, value]) => `${key}=${value}`),
    '',
  ].join('\n');
  await writeFile(ENV_FILE, content, { mode: 0o600 });
  log('Konfiguration (.env) geschrieben.');
  return values;
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

async function install(body: InstallRequest, send: (event: Record<string, unknown>) => void): Promise<void> {
  const log = (line: string) => send({ type: 'log', line });
  const step = (id: string, status: 'running' | 'ok' | 'error' | 'skipped', note = '') =>
    send({ type: 'step', id, status, note });

  step('env', 'running');
  const env = await writeEnv(body, log);
  step('env', 'ok');

  step('docker', 'running');
  log('Baue und starte die Container (beim ersten Mal einige Minuten) …');
  const up = await run('docker', ['compose', 'up', '-d', '--build'], log);
  if (!up.ok) {
    step('docker', 'error', 'docker compose up ist fehlgeschlagen – Details im Protokoll.');
    send({ type: 'done', ok: false });
    return;
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
    return;
  }

  if (!body.installWorker) {
    step('worker', 'skipped', 'Den Worker startest du später mit „npm run worker“.');
  } else {
    step('worker', 'running');
    const workerEnv = { ...process.env, DEV_LOG_DATABASE_URL: env.get('DEV_LOG_DATABASE_URL')! };
    Object.assign(process.env, workerEnv);
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
      const payload = (await body(request)) as Partial<InstallRequest>;
      const problem = validate(payload);
      if (problem) return json(response, 400, { message: problem });
      response.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' });
      await install(
        {
          username: payload.username!,
          password: payload.password!,
          domain: payload.domain ?? '',
          projectRoots: payload.projectRoots ?? '',
          installWorker: payload.installWorker !== false,
        },
        (event) => response.write(`${JSON.stringify(event)}\n`),
      );
      response.end();
      setTimeout(() => process.exit(0), 3000);
      return;
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
