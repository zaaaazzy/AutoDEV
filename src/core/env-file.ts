/**
 * .env des Einrichtungs-Assistenten: lesen, prüfen und zusammenführen (ohne Seiteneffekte beim Import).
 * Vorhandene Werte, Kommentare und die Reihenfolge der Zeilen bleiben erhalten; gesetzt werden nur die
 * Werte aus dem Formular. DEV_LOG_SECRET_KEY und DEV_LOG_DB_PASSWORD werden nur erzeugt, wenn sie fehlen.
 */
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, readFile, rename, writeFile } from 'node:fs/promises';
import { platform } from 'node:os';

export interface EnvInput {
  username: string;
  password: string;
  domain: string;
  projectRoots: string;
  /**
   * Worker als Compose-Dienst (Profil „worker“ in COMPOSE_PROFILES) statt auf dem Host. undefined lässt die
   * bisherige Wahl stehen.
   */
  workerContainer?: boolean;
  /** Anmeldung der Claude-CLI in den Agent-Containern (claude setup-token); leer lässt den bisherigen Wert stehen. */
  claudeToken?: string;
  /** Gruppe des Docker-Sockets (Linux), damit der Worker-Container ohne root auf Docker zugreifen darf. */
  dockerGid?: number | null;
}

export interface InstallInput extends EnvInput {
  installWorker: boolean;
  /** Beispielprojekt „Velowerk“ (ein Jahr Entwicklung in 25 Sprints) zum Ausprobieren anlegen. */
  demoData?: boolean;
}

export interface EnvPlan {
  content: string;
  values: Map<string, string>;
  /** Der Secret Key wurde neu erzeugt (vorher fehlte er oder war leer). */
  secretKeyCreated: boolean;
  /**
   * Das DB-Passwort wurde neu erzeugt. Eine schon angelegte Datenbank kennt es noch nicht (Postgres übernimmt
   * POSTGRES_PASSWORD nur beim ersten Anlegen) – der Assistent setzt es deshalb nach dem Start per ALTER USER.
   */
  dbPasswordCreated: boolean;
}

const KEY_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;
// Steuerzeichen (u. a. Zeilenumbrüche) würden in der .env zusätzliche Variablen erzeugen.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
const PLAIN_VALUE = /^[A-Za-z0-9_./:,@%+=-]*$/;
export const DEFAULT_DB_USER = 'devlog';

export const newSecretKey = (): string => randomBytes(32).toString('base64url');
export const newDbPassword = (): string => randomBytes(24).toString('hex');

function unquote(raw: string): string {
  const value = raw.trim();
  if (value.length >= 2 && (value[0] === "'" || value[0] === '"') && value.endsWith(value[0]))
    return value.slice(1, -1);
  return value.replace(/\s+#.*$/, '');
}

/** Liest die Werte einer .env (später stehende Zeilen gewinnen, wie bei Docker Compose). */
export function parseEnv(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    if (line.trimStart().startsWith('#')) continue;
    const match = KEY_LINE.exec(line);
    if (match) values.set(match[1]!, unquote(match[2]!));
  }
  return values;
}

/** Schreibt einen Wert so, dass Compose, Node und die Shell ihn gleich lesen (sonst in einfachen Anführungszeichen). */
export function formatEnvValue(value: string): string {
  if (CONTROL.test(value) || value.includes("'"))
    throw new Error("Werte in der .env dürfen keine Zeilenumbrüche, Steuerzeichen oder ' enthalten.");
  return PLAIN_VALUE.test(value) ? value : `'${value}'`;
}

/** Ersetzt die Zeilen der genannten Schlüssel (doppelte fallen weg) und hängt fehlende ans Ende an. */
export function mergeEnv(text: string, updates: Map<string, string>): string {
  const pending = new Map(updates);
  const seen = new Set<string>();
  const lines = text ? text.replace(/\r?\n$/, '').split(/\r?\n/) : [];
  const merged: string[] = [];
  for (const line of lines) {
    const match = line.trimStart().startsWith('#') ? null : KEY_LINE.exec(line);
    const key = match?.[1];
    if (!key || !updates.has(key)) {
      merged.push(line);
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(`${key}=${formatEnvValue(updates.get(key)!)}`);
    pending.delete(key);
  }
  if (!lines.length) merged.push('# AIdeation – erzeugt vom Einrichtungs-Assistenten');
  for (const [key, value] of pending) merged.push(`${key}=${formatEnvValue(value)}`);
  return `${merged.join('\n')}\n`;
}

/** Prüft die Formulareingaben auf Typ und Inhalt; liefert eine lesbare Meldung oder null. */
export function validateInstall(body: unknown): string | null {
  if (!body || typeof body !== 'object') return 'Ungültige Anfrage.';
  const { username, password, domain, projectRoots, installWorker, demoData, workerContainer, claudeToken } =
    body as Record<string, unknown>;
  if (typeof username !== 'string' || !/^[a-zA-Z0-9._-]{3,40}$/.test(username))
    return 'Benutzername: 3–40 Zeichen (Buchstaben, Ziffern, . _ -).';
  if (typeof password !== 'string' || password.length < 16) return 'Das Passwort braucht mindestens 16 Zeichen.';
  if (password.length > 200) return 'Das Passwort darf höchstens 200 Zeichen haben.';
  if (/[\s#"'$`\\]/.test(password) || CONTROL.test(password))
    return 'Bitte im Passwort keine Leerzeichen, Anführungszeichen, # $ ` oder \\ verwenden.';
  if (domain !== undefined && typeof domain !== 'string') return 'Die Domain muss ein Text sein.';
  if (domain && !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain.trim()))
    return 'Die Domain sieht ungültig aus (z. B. devlog.example.com).';
  if (projectRoots !== undefined && typeof projectRoots !== 'string') return 'Der Projektbereich muss ein Text sein.';
  if (projectRoots && (CONTROL.test(projectRoots) || projectRoots.includes("'")))
    return "Der Projektbereich darf keine Zeilenumbrüche, Steuerzeichen oder ' enthalten.";
  if (projectRoots && projectRoots.length > 4000) return 'Der Projektbereich ist zu lang.';
  if (installWorker !== undefined && typeof installWorker !== 'boolean')
    return 'Die Worker-Auswahl muss ja oder nein sein.';
  if (demoData !== undefined && typeof demoData !== 'boolean') return 'Die Beispieldaten-Wahl muss ja oder nein sein.';
  if (workerContainer !== undefined && typeof workerContainer !== 'boolean')
    return 'Die Wahl „Worker im Container“ muss ja oder nein sein.';
  if (claudeToken !== undefined && typeof claudeToken !== 'string') return 'Der Claude-Token muss ein Text sein.';
  if (claudeToken && !/^[A-Za-z0-9._-]{20,500}$/.test(claudeToken.trim()))
    return 'Der Claude-Token sieht ungültig aus (Ausgabe von „claude setup-token“ einfügen).';
  return null;
}

/** Baut die neue .env aus der bisherigen (leer, wenn es keine gibt) und den Formularwerten. */
export function planEnv(existing: string, input: EnvInput): EnvPlan {
  const current = parseEnv(existing);
  const updates = new Map<string, string>([
    ['DEV_LOG_AUTH', 'on'],
    ['DEV_LOG_USERNAME', input.username],
    ['DEV_LOG_PASSWORD', input.password],
  ]);

  // Ein vorhandener Schlüssel wird nie ersetzt – sonst sind verschlüsselte Werte nicht mehr lesbar.
  const secretKeyCreated = !current.get('DEV_LOG_SECRET_KEY')?.trim();
  if (secretKeyCreated) updates.set('DEV_LOG_SECRET_KEY', newSecretKey());

  const dbPasswordCreated = !current.get('DEV_LOG_DB_PASSWORD');
  const dbPassword = dbPasswordCreated ? newDbPassword() : current.get('DEV_LOG_DB_PASSWORD')!;
  if (dbPasswordCreated) updates.set('DEV_LOG_DB_PASSWORD', dbPassword);
  if (dbPasswordCreated || !current.get('DEV_LOG_DATABASE_URL')) {
    const user = current.get('DEV_LOG_DB_USER') || DEFAULT_DB_USER;
    updates.set(
      'DEV_LOG_DATABASE_URL',
      `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(dbPassword)}@localhost:5433/aideation`,
    );
  }

  // Leere Felder lassen bestehende Werte stehen.
  if (input.projectRoots.trim()) updates.set('DEV_LOG_PROJECT_ROOTS', input.projectRoots.trim());
  // Backup-Container läuft ohne root: unter Linux als eigener Benutzer, damit er in ./backups schreiben darf.
  if (platform() === 'linux' && process.getuid && process.getgid)
    updates.set('DEV_LOG_BACKUP_USER', `${process.getuid()}:${process.getgid()}`);
  // Profile zusammenführen: https (Domain) und worker (Worker im Container) schliessen sich nicht aus.
  const profiles = new Set(
    (current.get('COMPOSE_PROFILES') ?? '')
      .split(',')
      .map((profile) => profile.trim())
      .filter(Boolean),
  );
  if (input.domain.trim()) {
    updates.set('DEV_LOG_DOMAIN', input.domain.trim());
    updates.set('DEV_LOG_PUBLIC_URL', `https://${input.domain.trim()}`);
    profiles.add('https');
  }
  if (input.workerContainer === true) profiles.add('worker');
  if (input.workerContainer === false) profiles.delete('worker');
  const joined = [...profiles].join(',');
  if (joined !== (current.get('COMPOSE_PROFILES') ?? '')) updates.set('COMPOSE_PROFILES', joined);
  if (input.workerContainer) {
    // Worker-Container als eigener Benutzer (Linux): Dateien in den Projektordnern gehören weiter dir.
    if (platform() === 'linux' && process.getuid && process.getgid)
      updates.set('DEV_LOG_WORKER_USER', `${process.getuid()}:${process.getgid()}`);
    if (typeof input.dockerGid === 'number' && Number.isInteger(input.dockerGid) && input.dockerGid >= 0)
      updates.set('DEV_LOG_DOCKER_GID', String(input.dockerGid));
  }
  if (input.claudeToken?.trim()) updates.set('CLAUDE_CODE_OAUTH_TOKEN', input.claudeToken.trim());

  const content = mergeEnv(existing, updates);
  return { content, values: parseEnv(content), secretKeyCreated, dbPasswordCreated };
}

/**
 * Schreibt die .env mit Modus 0600. Eine vorhandene Datei wird vorher als `.env.bak-<Zeit>` gesichert
 * (ebenfalls 0600); geschrieben wird über eine temporäre Datei, damit nie eine halbe .env entsteht.
 */
export async function writeEnvFile(file: string, input: EnvInput): Promise<EnvPlan & { backup: string | null }> {
  const existing = existsSync(file) ? await readFile(file, 'utf8') : '';
  const plan = planEnv(existing, input);
  let backup: string | null = null;
  if (existsSync(file)) {
    backup = `${file}.bak-${Date.now()}`;
    await writeFile(backup, existing, { mode: 0o600, flag: 'wx' });
    await chmod(backup, 0o600);
  }
  const temporary = `${file}.tmp-${process.pid}`;
  await writeFile(temporary, plan.content, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, file);
  return { ...plan, backup };
}
