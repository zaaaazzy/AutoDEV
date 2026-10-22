/**
 * Lokale Datenbank aus docker-compose (Port 5433) für Skripte außerhalb der Container: Komplettlauf (test:full)
 * und E2E-Webserver. Zugang wie in docker-compose aus DEV_LOG_DB_USER und DEV_LOG_DB_PASSWORD der .env, damit
 * ein vom Einrichtungs-Assistenten erzeugtes Passwort gilt. Das Standardpasswort bleibt nur für eine .env ohne
 * eigenes Passwort (wie docker-compose selbst).
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { DEFAULT_DB_USER, parseEnv } from './env-file.js';

const DEFAULT_DB_PASSWORD = 'devlog_local_dev';

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

/**
 * Werte der .env im Ordner `root`; in einem Git-Worktree ohne eigene .env die des Hauptordners (sonst fiele etwa das
 * Test-Gate im Agent-Ordner auf das Standardpasswort zurück). Ohne lesbare Datei leer.
 */
export function readEnvValues(root: string): Map<string, string> {
  const own = join(root, '.env');
  const main = mainWorktreeRoot(root);
  const file = existsSync(own) || !main ? own : join(main, '.env');
  if (!existsSync(file)) return new Map();
  try {
    return parseEnv(readFileSync(file, 'utf8'));
  } catch {
    return new Map();
  }
}

/** Adresse der lokalen Datenbank; per URL-Parser, damit Sonderzeichen im Passwort korrekt kodiert sind. */
export function localDatabaseUrl(values: Map<string, string>, database = 'aideation', host = '127.0.0.1'): string {
  const url = new URL(`postgresql://${host}:5433/${database}`);
  url.username = values.get('DEV_LOG_DB_USER') || DEFAULT_DB_USER;
  url.password = values.get('DEV_LOG_DB_PASSWORD') || DEFAULT_DB_PASSWORD;
  return url.toString();
}

/** Admin-Ziel (Datenbank „postgres“) mit demselben Zugang, z. B. für E2E_ADMIN_DATABASE_URL. */
export function adminDatabaseUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.pathname = '/postgres';
  return url.toString();
}
