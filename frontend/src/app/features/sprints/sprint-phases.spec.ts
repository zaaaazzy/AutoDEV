import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canEditSprintOrders, moveId, orderSprint, phaseLabel, sprintPhase } from './sprint-phases.js';

test('Sprint-Aufträge: Umsortieren und Herausnehmen nur in geplanten oder aktiven Sprints mit Planungsrecht', () => {
  assert.equal(canEditSprintOrders('planned', true), true);
  assert.equal(canEditSprintOrders('active', true), true);
  for (const status of ['review', 'completed', 'cancelled']) {
    assert.equal(canEditSprintOrders(status, true), false, status);
  }
  assert.equal(canEditSprintOrders('active', false), false, 'ohne Planungsrecht');
});

test('Sprint-Phasen: Status werden eingeordnet, Backlog zählt als geplant', () => {
  assert.equal(sprintPhase({ status: 'in_progress' }), 'running');
  assert.equal(sprintPhase({ status: 'backlog' }), 'planned');
  assert.equal(sprintPhase({ status: 'planned' }), 'planned');
  assert.equal(sprintPhase({ status: 'approval' }), 'approval');
  assert.equal(sprintPhase({ status: 'done' }), 'done');
  assert.equal(phaseLabel('running'), 'In Arbeit');
});

test('Sprint-Phasen: erst nach Phase, darin nach Rang, ohne Rang nach Priorität', () => {
  const orders = [
    { id: 'done', status: 'done', priority: 'high' as const, sprintRank: 0 },
    { id: 'p2', status: 'planned', priority: 'high' as const, sprintRank: 2 },
    { id: 'p1', status: 'planned', priority: 'low' as const, sprintRank: 1 },
    { id: 'pHigh', status: 'backlog', priority: 'high' as const, sprintRank: null },
    { id: 'pLow', status: 'backlog', priority: 'low' as const },
    { id: 'run', status: 'in_progress', priority: 'low' as const, sprintRank: 5 },
  ];
  assert.deepEqual(
    orderSprint(orders).map((order) => order.id),
    ['run', 'p1', 'p2', 'pHigh', 'pLow', 'done'],
  );
});

test('Sprint-Phasen: verschieben, am Rand bleibt die Reihenfolge', () => {
  assert.deepEqual(moveId(['a', 'b', 'c'], 'c', -1), ['a', 'c', 'b']);
  assert.deepEqual(moveId(['a', 'b', 'c'], 'a', 1), ['b', 'a', 'c']);
  assert.deepEqual(moveId(['a', 'b', 'c'], 'a', -1), ['a', 'b', 'c']);
  assert.deepEqual(moveId(['a', 'b'], 'x', 1), ['a', 'b']);
});
