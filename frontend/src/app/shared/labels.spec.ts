import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ciLabel, orderTitle } from './labels.js';

test('CI-Ampel: grün, rot, läuft, sonst unbekannt', () => {
  assert.equal(ciLabel('success'), 'grün');
  assert.equal(ciLabel('failure'), 'rot');
  assert.equal(ciLabel('pending'), 'läuft');
  assert.equal(ciLabel(null), 'unbekannt');
  assert.equal(ciLabel(undefined), 'unbekannt');
});

test('Auftragstitel: Präfix „Bug:“ nur bei Bugs entfernen', () => {
  assert.equal(orderTitle({ kind: 'bug', title: 'Bug: Login hängt' }), 'Login hängt');
  assert.equal(orderTitle({ kind: 'bug', title: 'bug:Login hängt' }), 'Login hängt', 'Gross-/Kleinschreibung egal');
  assert.equal(orderTitle({ kind: 'bug', title: 'Login hängt' }), 'Login hängt');
  assert.equal(orderTitle({ kind: 'feature', title: 'Bug: Melder bauen' }), 'Bug: Melder bauen');
  assert.equal(orderTitle({ title: 'Bug: ohne Art' }), 'Bug: ohne Art');
});
