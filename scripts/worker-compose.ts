/**
 * Schreibt docker-compose.override.yml für den Worker im Container (src/setup/worker-compose.ts): AIdeation-Ordner,
 * Projektordner aus der .env und Git-Zugänge. start.sh und start.cmd rufen das vor „docker compose up“ auf.
 *   npx tsx scripts/worker-compose.ts
 */
import { join } from 'node:path';
import { OVERRIDE_FILE, writeWorkerOverride } from '../src/setup/worker-compose.js';

const ROOT = join(import.meta.dirname, '..');
const result = await writeWorkerOverride(ROOT);
if (result === 'kept') {
  console.warn(
    `! ${OVERRIDE_FILE} ist eine eigene Datei (ohne Kennzeichnung) und bleibt unverändert – der Worker im Container ` +
      'braucht darin AIdeation-Ordner und Projektordner (docs/betrieb.md).',
  );
} else if (result === 'written') {
  console.log(`→ ${OVERRIDE_FILE} für den Worker im Container geschrieben.`);
}
