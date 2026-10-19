import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hadOutage, missingFolderMessage, noteFolders, resetOutages, volumeOf } from './folder-guard.js';

const PATH = '/Volumes/External/DevLog';

test('Laufwerk aus dem Pfad und verständliche Meldung', () => {
  assert.equal(volumeOf(PATH), '/Volumes/External');
  assert.equal(volumeOf('/Users/me/code'), null);
  assert.match(missingFolderMessage(PATH), /Laufwerk „External“ ist nicht verbunden/);
  assert.equal(missingFolderMessage('/tmp/x'), 'Ordner nicht erreichbar: /tmp/x');
});

test('Kurzer Ausfall während eines Laufs zählt als Unterbrechung, ein Ausfall davor nicht', () => {
  resetOutages();
  let online = true;
  const available = () => online;
  assert.deepEqual(noteFolders([PATH], 1_000, available), { lost: [], back: [] });
  online = false;
  assert.deepEqual(noteFolders([PATH], 2_000, available), { lost: [PATH], back: [] });
  assert.deepEqual(noteFolders([PATH], 3_000, available), { lost: [], back: [] }, 'nur einmal gemeldet');
  online = true;
  assert.deepEqual(noteFolders([PATH], 4_000, available), { lost: [], back: [PATH] });
  // Lauf von 1,5 s bis 10 s: Ausfall 2–4 s fällt hinein.
  assert.equal(hadOutage(PATH, 1_500, 10_000, available), true);
  // Lauf erst ab 5 s gestartet: der Ausfall lag davor.
  assert.equal(hadOutage(PATH, 5_000, 10_000, available), false);
  // Jetzt nicht erreichbar: immer Unterbrechung.
  assert.equal(
    hadOutage(PATH, 5_000, 10_000, () => false),
    true,
  );
});
