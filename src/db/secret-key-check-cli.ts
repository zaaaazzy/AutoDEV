import pg from 'pg';
import { checkSecretKey, secretKeyProblem } from './secret-key-check.js';

/**
 * Entschlüsselungs-Test für scripts/restore.sh: liest DEV_LOG_CHECK_DATABASE_URL (die frisch eingespielte Datenbank)
 * und prüft alle verschlüsselten Werte mit DEV_LOG_SECRET_KEY. Ausgabe nur Zahlen; Exit 1 = nicht lesbar.
 */
const url = process.env.DEV_LOG_CHECK_DATABASE_URL?.trim();
if (!url) {
  console.error('DEV_LOG_CHECK_DATABASE_URL fehlt.');
  process.exit(2);
}
const pool = new pg.Pool({ connectionString: url, connectionTimeoutMillis: 10_000, max: 1 });
pool.on('error', () => undefined);

checkSecretKey(pool)
  .then((result) => {
    const problem = secretKeyProblem(result);
    if (problem) {
      console.error(`Schlüssel-Test fehlgeschlagen: ${problem}`);
      process.exitCode = 1;
    } else {
      console.log(`Schlüssel-Test bestanden: ${result.encrypted} verschlüsselte Werte lesbar.`);
    }
  })
  .catch((error: unknown) => {
    console.error(`Schlüssel-Test nicht möglich: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  })
  .finally(() => void pool.end());
