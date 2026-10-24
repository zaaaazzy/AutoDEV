import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatElapsed, pullNote } from './restart-text.js';

test('Neustart-Leiste: Hinweis aus der ersten Log-Zeile, ob der neueste Stand geholt wurde', () => {
  assert.equal(
    pullNote('Neuester Stand von origin/main geholt (1111111 → 2222222).\n\n#1 building'),
    'Neuester Stand von origin/main geholt (1111111 → 2222222).',
  );
  assert.equal(
    pullNote('GitHub nicht erreichbar (…) – gebaut wird der lokale Stand.'),
    'GitHub nicht erreichbar (…) – gebaut wird der lokale Stand.',
  );
  assert.equal(pullNote('#21 exporting manifest'), '', 'ältere Neustarts ohne Hinweis');
  assert.equal(pullNote(null), '');
});

test('Neustart-Leiste: Laufzeit in Sekunden, ab einer Minute mit Minuten', () => {
  assert.equal(formatElapsed(42_400), '42 s');
  assert.equal(formatElapsed(95_000), '1 min 35 s');
  assert.equal(formatElapsed(-5), '0 s');
});
