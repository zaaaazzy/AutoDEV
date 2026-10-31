/**
 * .env der Installation für Prozesse außerhalb der Container: Worker, Wächter, Komplettlauf (test:full) und
 * E2E-Webserver. Gelesen wird immer über parseEnv (dieselben Regeln wie der Einrichtungs-Assistent beim Schreiben).
 * Ein Standardpasswort gibt es hier nicht: Fehlt der Zugang, brechen die Aufrufer mit einer klaren Meldung ab, statt
 * sich mit einem veralteten Passwort an der Datenbank anzumelden.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { ALLOW_DEFAULT_DB_PASSWORD, DEFAULT_DB_PASSWORD } from './default-credentials.js';
import { DEFAULT_DB_USER, parseEnv } from './env-file.js';

/**
 * Hauptordner zu einem Git-Worktree (Agent-Ordner, Arbeitsordner): dort liegt die .env. Ein Worktree hat statt des
 * Ordners .git eine Datei „gitdir: <haupt>/.git/worktrees/<name>“. Sonst null.
 */
export function mainWorktreeRoot(root: string): string | null {
  try {
    const marker = join(root, '.git');
    if (!existsSync(marker) || !statSync(marker).isFile()) return null;
    const gitdir = /^gitdir:\s*(.+)$/m.exec(readFileSync(marker, 'utf8'))?.[1]?.trim();
    const index = gitdir?.lastIndexOf(`${sep}.git${sep}worktrees${sep}`) ?? -1;
    return gitdir && index > 0 ? gitdir.slice(0, index) : null;
  } catch {
    return null;
  }
}

/** Pfad der .env zu `root`; in einem Git-Worktree ohne eigene .env die des Hauptordners. */
export function envFilePath(root: string): string {
  const own = join(root, '.env');
  const main = mainWorktreeRoot(root);
  return existsSync(own) || !main ? own : join(main, '.env');
}

/**
 * Werte der .env im Ordner `root`; in einem Git-Worktree ohne eigene .env die des Hauptordners (sonst fiele etwa das
 * Test-Gate im Agent-Ordner auf das Standardpasswort zurück). Ohne lesbare Datei leer.
 */
export function readEnvValues(root: string): Map<string, string> {
  const file = envFilePath(root);
  if (!existsSync(file)) return new Map();
  try {
    return parseEnv(readFileSync(file, 'utf8'));
  } catch {
    return new Map();
  }
}

/**
 * Schlüssel, die Worker und Wächter aus der .env übernehmen. Bewusst nur diese: Anmeldedaten der Oberfläche
 * (DEV_LOG_PASSWORD) gehören nicht in die Umgebung, die Agents erben.
 */
export const INSTALL_ENV_KEYS = [
  'DEV_LOG_DATABASE_URL',
  'DEV_LOG_REVIEW_DATABASE_URL',
  'DEV_LOG_SECRET_KEY',
  'DEV_LOG_PUBLIC_URL',
  'DEV_LOG_DOMAIN',
  'DEV_LOG_PROJECT_ROOTS',
] as const;

/**
 * Übernimmt INSTALL_ENV_KEYS aus der .env in `environment`. Schon gesetzte Werte bleiben (die Umgebung bzw. die
 * Env-Datei des Dienstes hat Vorrang). Eine fehlende .env ist kein Fehler; liefert die übernommenen Schlüssel.
 */
export function loadInstallEnv(root: string, environment: NodeJS.ProcessEnv = process.env): string[] {
  const values = readEnvValues(root);
  const loaded: string[] = [];
  for (const key of INSTALL_ENV_KEYS) {
    const value = values.get(key);
    if (environment[key]?.trim() || !value) continue;
    environment[key] = value;
    loaded.push(key);
  }
  return loaded;
}

/** DEV_LOG_DATABASE_URL aus der Umgebung; fehlt sie, ein Fehler mit Hinweis statt eines Standardwerts. */
export function requireDatabaseUrl(environment: NodeJS.ProcessEnv = process.env): string {
  const url = environment.DEV_LOG_DATABASE_URL?.trim();
  if (url) return url;
  throw new Error(
    'DEV_LOG_DATABASE_URL fehlt – weder in der Umgebung noch in der .env der Installation. ' +
      './start.sh --setup ausführen (schreibt die .env) und den Dienst neu installieren (docs/betrieb.md).',
  );
}

/**
 * Adresse der lokalen Datenbank (docker-compose, Port 5433) aus DEV_LOG_DB_USER und DEV_LOG_DB_PASSWORD der .env;
 * per URL-Parser, damit Sonderzeichen im Passwort korrekt kodiert sind. Ohne DEV_LOG_DB_PASSWORD ein Fehler – das
 * Standardpasswort nur mit DEV_LOG_ALLOW_DEFAULT_DB_PASSWORD=1 (Wegwerf-Umgebung).
 */
export function localDatabaseUrl(
  values: Map<string, string>,
  database = 'aideation',
  host = '127.0.0.1',
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const password = values.get('DEV_LOG_DB_PASSWORD');
  if (!password && environment[ALLOW_DEFAULT_DB_PASSWORD] !== '1')
    throw new Error(
      'DEV_LOG_DB_PASSWORD fehlt in der .env – ohne Passwort kein Zugang zur lokalen Datenbank. ' +
        './start.sh --setup ausführen oder die Adresse vorgeben (DEV_LOG_DATABASE_URL bzw. E2E_ADMIN_DATABASE_URL).',
    );
  const url = new URL(`postgresql://${host}:5433/${database}`);
  url.username = values.get('DEV_LOG_DB_USER') || DEFAULT_DB_USER;
  url.password = password || DEFAULT_DB_PASSWORD;
  return url.toString();
}

/** Admin-Ziel (Datenbank „postgres“) mit demselben Zugang, z. B. für E2E_ADMIN_DATABASE_URL. */
export function adminDatabaseUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.pathname = '/postgres';
  return url.toString();
}
