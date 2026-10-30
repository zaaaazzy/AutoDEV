import { createDevLogApp } from './api/app.js';
import { loadTotpSecret, sealStoredTotpSecrets, startSessionCleanup } from './api/auth.js';
import { encryptProjectSecrets } from './api/projects.js';
import { sealStoredVapidKeys } from './core/push.js';
import { createDatabasePool, readDatabaseConfig } from './db/database.js';

async function start(): Promise<void> {
  const username = process.env.DEV_LOG_USERNAME?.trim();
  const password = process.env.DEV_LOG_PASSWORD;
  const authDisabled = process.env.DEV_LOG_AUTH === 'off';
  // Standardmäßig nur lokal erreichbar; nach aussen (z. B. im Container hinter nginx) mit DEV_LOG_HOST=0.0.0.0.
  const host = process.env.DEV_LOG_HOST?.trim() || '127.0.0.1';
  if (!authDisabled && (!username || !password || password.length < 16)) {
    throw new Error('Set DEV_LOG_USERNAME and a DEV_LOG_PASSWORD of at least 16 characters, or DEV_LOG_AUTH=off.');
  }
  if (authDisabled) {
    console.warn(
      'WARNUNG: DEV_LOG_AUTH=off – die API ist ohne Login erreichbar und steuert Agents mit Datei- und Befehlsrechten. Nur in vertrauenswürdigen Netzen betreiben; Projektordner lassen sich mit DEV_LOG_PROJECT_ROOTS begrenzen.',
    );
  }
  const pool = await createDatabasePool(readDatabaseConfig());
  const encrypted = await encryptProjectSecrets(pool);
  if (encrypted) console.info(`${encrypted} Datenbank-Zugang/Zugänge verschlüsselt.`);
  // Zwei-Faktor-Schlüssel aus der Zeit vor der Verschlüsselung neu schreiben; ohne Schlüssel startet der Dienst nicht.
  const sealed = await sealStoredTotpSecrets(pool);
  if (sealed) console.info(`${sealed} Zwei-Faktor-Schlüssel verschlüsselt.`);
  // Ebenso den privaten VAPID-Schlüssel (Push), damit er nicht im Klartext in Backups steht.
  if (await sealStoredVapidKeys(pool)) console.info('Push-Schlüssel verschlüsselt.');
  const port = Number(process.env.PORT ?? 3100);
  const auth =
    username && password && !authDisabled ? { username, password, totpSecret: await loadTotpSecret(pool) } : null;
  // Abgelaufene und an ein altes Passwort gebundene Sitzungen löschen (sofort im Hintergrund, danach stündlich).
  const stopCleanup = startSessionCleanup(pool, auth);
  const server = createDevLogApp(pool, auth).listen(port, host, () => {
    console.info(`AIdeation listening on ${host}:${port}.`);
  });
  const shutdown = (): void => {
    stopCleanup();
    server.close(() => void pool.end());
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

start().catch((error: unknown) => {
  console.error('AIdeation startup failed:', error);
  process.exitCode = 1;
});
