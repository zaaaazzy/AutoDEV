import assert from 'node:assert/strict';
import test from 'node:test';
import { stepProgress } from './test-progress.js';

test('Playwright: erledigt von gesamt, grün/rot und der zuletzt fertige Test', () => {
  const output = [
    'Running 28 tests using 1 worker',
    '',
    '  ✓   1 [desktop] › e2e/full-ui.check.ts:325:1 › Alle Seiten laden ohne Fehler (2.4s)',
    '  ✘   2 [desktop] › e2e/full-ui.check.ts:354:1 › Tabellen: Sortieren, Filtern (59.8s)',
    '  -   3 [desktop] › e2e/full-ui.check.ts:400:1 › Nur Handy',
    '  ✓   4 [handy] › e2e/full-ui.check.ts:522:1 › Sprints: Datum prüfen, anlegen (1.8s)',
  ].join('\n');
  const progress = stepProgress(output);
  assert.deepEqual([progress.done, progress.total, progress.failed], [4, 28, 1]);
  assert.equal(progress.text, '4 von 28 Tests · 2 ✓ · 1 ✗ · 1 übersprungen · zuletzt: Sprints: Datum prüfen, anlegen');
});

test('TAP (node --test): Zählung ohne Gesamtzahl, am Ende mit', () => {
  const running = 'ok 1 - a\nok 2 - b\nnot ok 3 - c\n';
  assert.equal(stepProgress(running).text, '3 Tests · 2 ✓ · 1 ✗');
  assert.equal(stepProgress(`${running}# tests 3\n`).text, '3 von 3 Tests · 2 ✓ · 1 ✗');
});

test('Vor den Tests: Build bzw. allgemein „läuft“', () => {
  assert.equal(stepProgress('> ng build --configuration production\nBuilding…').text, 'Oberfläche wird gebaut …');
  assert.equal(stepProgress('Application bundle generation complete. [7s]').text, 'Oberfläche gebaut, Tests starten …');
  assert.equal(stepProgress('> eslint .').text, 'läuft …');
});
