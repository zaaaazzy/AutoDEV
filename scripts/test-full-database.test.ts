import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// Das Test-Gate eines Sprints läuft mit dessen noch nicht freigegebenem Code. Legt es den Lauf in AIdeation ab, darf es
// die Datenbank der laufenden Installation nicht migrieren (createDatabasePool führt die Migrationen aus).
test('test:full schreibt in die AIdeation-Datenbank, ohne sie zu migrieren', () => {
  const source = readFileSync(new URL('./test-full.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /createDatabasePool/);
  assert.match(source, /connectExistingDatabase\(/);
});
