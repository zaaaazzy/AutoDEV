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

/** Warnt (ohne die URL auszugeben), wenn die Datenbank mit dem Standardpasswort angesprochen wird. */
export function warnDefaultDatabasePassword(databaseUrl: string, warn: (message: string) => void = console.warn): void {
  if (!usesDefaultDatabasePassword(databaseUrl)) return;
  warn(
    `WARNUNG: Die Datenbank nutzt das Standardpasswort „${DEFAULT_DB_PASSWORD}“. ` +
      'DEV_LOG_DB_PASSWORD in der .env setzen, das Passwort in PostgreSQL ändern und den Worker neu installieren ' +
      '(docs/installation.md).',
  );
}
