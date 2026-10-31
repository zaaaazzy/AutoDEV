import assert from 'node:assert/strict';
import { test } from 'node:test';
import { requestState, sprintRequests } from './sprint-requests.js';

test('Anfragen: genau die Umsetzungen des Sprints in Freigabe, wartende vor abgenommenen', () => {
  const items = [
    { id: 'a', sprintId: 's1', status: 'approval', reviewApprovedAt: '2026-10-31T10:00:00Z' },
    { id: 'b', sprintId: 's1', status: 'approval', reviewApprovedAt: null },
    { id: 'c', sprintId: 's1', status: 'done', reviewApprovedAt: null },
    { id: 'd', sprintId: 's2', status: 'approval', reviewApprovedAt: null },
    { id: 'e', sprintId: null, status: 'approval' },
  ];
  assert.deepEqual(
    sprintRequests(items, 's1').map((item) => item.id),
    ['b', 'a'],
  );
});

test('Anfragen: abgenommene tragen den Vermerk „wird gemergt“', () => {
  assert.equal(requestState({ status: 'approval', reviewApprovedAt: null }), 'Wartet auf Abnahme');
  assert.match(requestState({ status: 'approval', reviewApprovedAt: '2026-10-31T10:00:00Z' }), /wird gemergt/);
});
