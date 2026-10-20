import assert from 'node:assert/strict';
import test from 'node:test';
import { SCHEMA } from './schema.js';

// Das Schema läuft bei jedem Start als ein Aufruf. Jede Fassung von bugs_source_check wird gegen die bereits
// vorhandenen Zeilen geprüft; fehlt in einer Zwischenfassung ein Wert wie 'github', scheitert der Start.
test('bugs_source_check: jede Fassung erlaubt alle Quellen, die der Code schreibt (auch github)', () => {
  const versions = [...SCHEMA.matchAll(/ADD CONSTRAINT bugs_source_check\s+CHECK \(source IN \(([^)]*)\)\)/g)].map(
    (match) => [...match[1].matchAll(/'([^']+)'/g)].map((value) => value[1]),
  );
  assert.ok(versions.length >= 1);
  for (const [index, sources] of versions.entries()) {
    assert.ok(sources.includes('github'), `Fassung ${index + 1} von bugs_source_check enthält 'github' nicht`);
  }
  // Spätere Fassungen dürfen nichts entfernen.
  for (let index = 1; index < versions.length; index += 1) {
    for (const source of versions[index - 1]) {
      assert.ok(versions[index].includes(source), `Fassung ${index + 1} verliert '${source}'`);
    }
  }
});
