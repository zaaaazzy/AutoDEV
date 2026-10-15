import { createDevLogApp } from './app.js';
import { createDatabasePool, readDatabaseConfig } from './database.js';

async function start(): Promise<void> {
  const username = process.env.DEV_LOG_USERNAME?.trim();
  const password = process.env.DEV_LOG_PASSWORD;
  const authDisabled = process.env.DEV_LOG_AUTH === 'off';
  if (!authDisabled && (!username || !password || password.length < 16)) {
    throw new Error('Set DEV_LOG_USERNAME and a DEV_LOG_PASSWORD of at least 16 characters, or DEV_LOG_AUTH=off.');
  }
  const pool = await createDatabasePool(readDatabaseConfig());
  const port = Number(process.env.PORT ?? 3100);
  const server = createDevLogApp(pool, authDisabled ? null : { username: username!, password: password! }).listen(port, '0.0.0.0', () => {
    console.info(`Dev Log listening on port ${port}.`);
  });
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
