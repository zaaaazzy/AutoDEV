import { createDevLogApp } from './api/app.js';
import { createDatabasePool, readDatabaseConfig } from './db/database.js';

async function start(): Promise<void> {
  const username = process.env.DEV_LOG_USERNAME?.trim();
  const password = process.env.DEV_LOG_PASSWORD;
  const authDisabled = process.env.DEV_LOG_AUTH === 'off';
  const host = process.env.DEV_LOG_HOST ?? (authDisabled ? '127.0.0.1' : '0.0.0.0');
  if (!authDisabled && (!username || !password || password.length < 16)) {
    throw new Error('Set DEV_LOG_USERNAME and a DEV_LOG_PASSWORD of at least 16 characters, or DEV_LOG_AUTH=off.');
  }
  if (authDisabled) {
    console.warn(
      'WARNUNG: DEV_LOG_AUTH=off – die API ist ohne Login erreichbar und steuert Agents mit Datei- und Befehlsrechten. Nur in vertrauenswürdigen Netzen betreiben; Projektordner lassen sich mit DEV_LOG_PROJECT_ROOTS begrenzen.',
    );
  }
  const bind = process.env.DEV_LOG_BIND?.trim();
  if (bind && !['127.0.0.1', 'localhost', '::1'].includes(bind)) {
    console.warn(
      `WARNUNG: DEV_LOG_BIND=${bind} – Dev Log ist im Netz erreichbar, Benutzername und Passwort gehen per HTTP unverschlüsselt über die Leitung. Wer sie mitliest, kann über Agent-, Test- und Deploy-Befehle beliebige Befehle auf diesem Rechner ausführen. Besser: DEV_LOG_BIND=127.0.0.1 und Zugriff über HTTPS-Proxy, Tailscale oder SSH-Tunnel.`,
    );
  }
  const pool = await createDatabasePool(readDatabaseConfig());
  const port = Number(process.env.PORT ?? 3100);
  const server = createDevLogApp(pool, username && password && !authDisabled ? { username, password } : null).listen(
    port,
    host,
    () => {
      console.info(`Dev Log listening on ${host}:${port}.`);
    },
  );
  const shutdown = (): void => {
    server.close(() => void pool.end());
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

start().catch((error: unknown) => {
  console.error('Dev Log startup failed:', error);
  process.exitCode = 1;
});
