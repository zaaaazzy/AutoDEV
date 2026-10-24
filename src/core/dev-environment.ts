// Leitplanken für `npm run dev`: Die Dev-API darf weder den Port noch die Datenbank des Live-Stacks nutzen.

/** Port der Dev-API; frontend/proxy.conf.json leitet `ng serve` dorthin weiter. 3100 gehört dem Live-Stack. */
export const DEV_API_PORT = 3101;

/** Name der Live-Datenbank (docker-compose.yml, POSTGRES_DB). */
const LIVE_DATABASE = 'aideation';
const LIVE_PORTS = new Set([3100, 80, 443, 5433]);

/** Meldung, wenn die Dev-Umgebung auf den Live-Stack zeigt; sonst null. */
export function devEnvironmentProblem(environment: NodeJS.ProcessEnv): string | null {
  const port = Number(environment.PORT);
  if (LIVE_PORTS.has(port)) {
    return `PORT=${port} gehört dem Live-Stack (docker compose). Für npm run dev ohne PORT starten (Standard ${DEV_API_PORT}).`;
  }
  const databaseUrl = environment.DEV_LOG_DATABASE_URL?.trim();
  if (!databaseUrl) return null;
  let name: string;
  try {
    name = decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//, ''));
  } catch {
    return null; // readDatabaseConfig meldet ungültige Adressen selbst.
  }
  if (name === LIVE_DATABASE) {
    return `DEV_LOG_DATABASE_URL zeigt auf die Live-Datenbank "${LIVE_DATABASE}". Für npm run dev eine eigene Datenbank angeben, z. B. …/aideation_dev (wird beim Start angelegt).`;
  }
  return null;
}
