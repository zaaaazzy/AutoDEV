import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canTakeIntoSprint } from '../../../../../src/core/development-transitions.js';
import { pickInOrder } from './pool-selection.js';

test('Auswahl: in Anzeige-Reihenfolge, nicht mehr verfügbare fallen weg', () => {
  const items = [{ id: 'c' }, { id: 'a' }, { id: 'b' }];
  assert.deepEqual(
    pickInOrder(items, new Set(['b', 'c', 'weg'])).map((item) => item.id),
    ['c', 'b'],
  );
});

test('Pool „Aufträge hinzufügen“: laufende und freizugebende Aufträge nach Sprint-Abbruch fehlen (Route lehnt sie ab)', () => {
  const removed = { sprintId: null, kind: 'feature', removedFromSprintAt: '2026-10-21' };
  for (const status of ['in_progress', 'approval', 'done', 'rejected']) {
    assert.equal(canTakeIntoSprint({ status, ...removed }), false, status);
  }
  for (const status of ['backlog', 'planned', 'blocked']) {
    assert.equal(canTakeIntoSprint({ status, ...removed }), true, status);
  }
  assert.equal(canTakeIntoSprint({ status: 'backlog', sprintId: 'sprint', kind: 'feature' }), false, 'schon im Sprint');
  assert.equal(canTakeIntoSprint({ status: 'backlog', sprintId: null, kind: 'express' }), false, 'Express');
});
