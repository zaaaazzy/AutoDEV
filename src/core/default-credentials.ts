/** Öffentlich bekanntes Standardpasswort aus docker-compose.yml (gilt ohne DEV_LOG_DB_PASSWORD in der .env). */
export const DEFAULT_DB_PASSWORD = 'devlog_local_dev';

/** True, wenn die Datenbank-URL das Standardpasswort nutzt. */
export function usesDefaultDatabasePassword(databaseUrl: string): boolean {
  try {
    return decodeURIComponent(new URL(databaseUrl).password) === DEFAULT_DB_PASSWORD;
  } catch {
    return false;
  }
}

/** Ausdrückliche Freigabe des Standardpassworts (nur für Wegwerf-Umgebungen ohne Zugriff von aussen). */
export const ALLOW_DEFAULT_DB_PASSWORD = 'DEV_LOG_ALLOW_DEFAULT_DB_PASSWORD';

/**
 * Bricht ab (ohne die URL auszugeben), wenn die Datenbank mit dem Standardpasswort angesprochen wird. Postgres-Benutzer
 * devlog ist Superuser und aus Review-Containern erreichbar – ein öffentlich bekanntes Passwort genügt dann für alles.
 */
export function refuseDefaultDatabasePassword(
  databaseUrl: string,
  environment: NodeJS.ProcessEnv = process.env,
  warn: (message: string) => void = console.warn,
): void {
  if (!usesDefaultDatabasePassword(databaseUrl)) return;
  if (environment[ALLOW_DEFAULT_DB_PASSWORD] === '1') {
    warnDefaultDatabasePassword(databaseUrl, warn);
    return;
  }
  throw new Error(
    `Die Datenbank nutzt das öffentlich bekannte Standardpasswort „${DEFAULT_DB_PASSWORD}“ – Start abgebrochen. ` +
      './start.sh --setup erneut ausführen (setzt ein zufälliges DEV_LOG_DB_PASSWORD und ändert es in PostgreSQL), ' +
      `danach den Worker neu installieren (docs/installation.md). Nur für Wegwerf-Umgebungen: ${ALLOW_DEFAULT_DB_PASSWORD}=1.`,
  );
}

/** Warnt (ohne die URL auszugeben), wenn die Datenbank mit dem Standardpasswort angesprochen wird. */
export function warnDefaultDatabasePassword(databaseUrl: string, warn: (message: string) => void = console.warn): void {
  if (!usesDefaultDatabasePassword(databaseUrl)) return;
  warn(
    `WARNUNG: Die Datenbank nutzt das Standardpasswort „${DEFAULT_DB_PASSWORD}“. ` +
      'DEV_LOG_DB_PASSWORD in der .env setzen, das Passwort in PostgreSQL ändern und den Worker neu installieren ' +
      '(docs/installation.md).',
  );
}
