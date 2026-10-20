import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEVELOPMENT_STATUSES } from '../../shared/labels.js';
import { newestSprints, opensActions, ORDER_STATUSES, ORDER_TONES } from './order-shares.js';

test('Dashboard zählt jeden Auftrags-Status, auch „Wartet auf Freigabe“', () => {
  assert.deepEqual([...ORDER_STATUSES].sort(), [...DEVELOPMENT_STATUSES].sort());
  for (const status of DEVELOPMENT_STATUSES) assert.ok(ORDER_TONES[status], status);
});

test('Freigabe, Abgelehnt und Blockiert führen auf die Seite „Aktionen“', () => {
  assert.equal(opensActions('approval'), true);
  assert.equal(opensActions('rejected'), true);
  assert.equal(opensActions('blocked'), true);
  assert.equal(opensActions('in_progress'), false);
  assert.equal(opensActions('done'), false);
});

test('Bei 10 Sprints werden die 8 neuesten gezeigt', () => {
  // Reihenfolge wie von der API: aktiv zuerst, dann abgeschlossene aufsteigend.
  const sprints = [
    { id: 's10', startDate: '2026-10-12', endDate: null },
    ...Array.from({ length: 9 }, (_, index) => ({
      id: `s${index + 1}`,
      startDate: `2026-0${index + 1}-01`,
      endDate: null,
    })),
  ];
  assert.deepEqual(
    newestSprints(sprints, 8).map((sprint) => sprint.id),
    ['s10', 's9', 's8', 's7', 's6', 's5', 's4', 's3'],
  );
});

test('Sprints ohne Datum (noch nicht terminiert) stehen vorne', () => {
  const sprints = [
    { id: 'alt', startDate: '2026-01-01', endDate: null },
    { id: 'geplant', startDate: null, endDate: null },
    { id: 'nur-ende', startDate: null, endDate: '2026-05-01' },
  ];
  assert.deepEqual(
    newestSprints(sprints, 8).map((sprint) => sprint.id),
    ['geplant', 'nur-ende', 'alt'],
  );
});
