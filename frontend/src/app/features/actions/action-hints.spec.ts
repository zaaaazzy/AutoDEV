import assert from 'node:assert/strict';
import { test } from 'node:test';
import { actionHint } from './action-hints.js';

test('Aktionen: jeder Knopf erklärt sich per Hover-Text', () => {
  for (const label of [
    'Erneut versuchen',
    'Angepasst – erneut versuchen',
    'So umsetzen lassen',
    'Wieder einplanen',
    'Geprüft – alles in Ordnung',
    'Neu analysieren',
    'Details',
    'Details ausblenden',
    '✓ Freigeben',
    '↩ Zurückweisen',
  ]) {
    assert.ok(actionHint(label).length > 20, label);
  }
  assert.equal(actionHint('Unbekannt'), '');
});

test('Aktionen: „Erneut versuchen“ und „Neu analysieren“ grenzen sich voneinander ab', () => {
  assert.match(actionHint('Erneut versuchen'), /Agents/);
  assert.match(actionHint('Erneut versuchen'), /Neu analysieren/);
  assert.match(actionHint('Neu analysieren'), /kein Code/);
});
