import assert from 'node:assert/strict';
import test from 'node:test';
import { type AgentStatusRow, markManualAgents } from './worker.js';

function agents(): AgentStatusRow[] {
  return [
    { id: 'tester', name: 'Tester', orderTitle: null, active: false },
    { id: 'dev', name: 'Entwickler', orderTitle: 'Login bauen', active: true },
    { id: 'docs', name: 'Handbuch-Autor', orderTitle: null, active: false },
  ];
}

test('Kopfzeile: manuell gestartete Aufgabe zeigt ihren Agent als aktiv statt den Dashboard-Assistenten', () => {
  const list = agents();
  const rest = markManualAgents(list, [
    { content: 'Führe die Tests aus', status: 'processing', agentId: 'tester', task: 'Tests ausführen' },
    { content: 'Wie viele Aufträge sind offen?', status: 'processing', agentId: null, task: null },
  ]);
  assert.deepEqual(list[0], {
    id: 'tester',
    name: 'Tester',
    orderTitle: 'Aufgabe: Tests ausführen',
    active: true,
    waiting: false,
    manual: true,
  });
  // Ohne Agent bleibt die Anfrage beim Dashboard-Assistenten.
  assert.deepEqual(
    rest.map((request) => request.content),
    ['Wie viele Aufträge sind offen?'],
  );
});

test('Kopfzeile: wartende Chat-Anfrage an einen Agent, Workflow-Lauf geht vor', () => {
  const list = agents();
  const rest = markManualAgents(list, [
    { content: 'Bitte\n  das Handbuch   prüfen', status: 'pending', agentId: 'docs', task: null },
    { content: 'Noch etwas', status: 'processing', agentId: 'dev', task: null },
    { content: 'Unbekannt', status: 'processing', agentId: 'geloescht', task: null },
  ]);
  assert.equal(list[2]?.waiting, true);
  assert.equal(list[2]?.active, false);
  assert.equal(list[2]?.orderTitle, 'Wartet – Chat: Bitte das Handbuch prüfen');
  // Der Entwickler arbeitet schon an einem Auftrag: Anzeige bleibt.
  assert.equal(list[1]?.orderTitle, 'Login bauen');
  // Ein Agent, den es nicht (mehr) gibt: die Anfrage zählt beim Assistenten.
  assert.deepEqual(
    rest.map((request) => request.agentId),
    ['geloescht'],
  );
});
