import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEVELOPMENT_STATUSES } from '../../shared/labels.js';
import {
  agentWorkload,
  newestSprints,
  NO_AGENT,
  opensActions,
  orderAgentName,
  ORDER_STATUSES,
  ORDER_TONES,
} from './order-shares.js';

test('Verteilung je Agent: Balken plus „Ohne Agent“ ergeben die offenen Aufträge', () => {
  const agents = [
    { id: 'a1', name: 'Entwickler' },
    { id: 'a2', name: 'Tester' },
  ];
  const items = [
    { agentId: 'a1', status: 'planned' },
    { agentId: 'a1', status: 'in_progress' },
    { agentId: 'a1', status: 'done' },
    { agentId: 'a2', status: 'rejected' },
    { agentId: null, status: 'backlog' },
    { agentId: 'geloescht', status: 'blocked' },
  ] as const;
  const rows = agentWorkload(items, agents);
  assert.deepEqual(rows, [
    { id: 'a1', label: 'Entwickler', value: 2 },
    { id: 'a2', label: 'Tester', value: 0 },
    { id: null, label: NO_AGENT, value: 2 },
  ]);
  const open = items.filter((item) => item.status !== 'done' && item.status !== 'rejected').length;
  assert.equal(
    rows.reduce((sum, row) => sum + row.value, 0),
    open,
  );
  // Spalte „Agent“ der Auftragsliste nutzt dieselben Namen wie die Balken.
  assert.equal(orderAgentName(items[0], agents), 'Entwickler');
  assert.equal(orderAgentName(items[5], agents), NO_AGENT);
});

test('Verteilung ohne Agents enthält nur „Ohne Agent“', () => {
  assert.deepEqual(agentWorkload([{ agentId: null, status: 'planned' }], []), [
    { id: null, label: NO_AGENT, value: 1 },
  ]);
});

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
