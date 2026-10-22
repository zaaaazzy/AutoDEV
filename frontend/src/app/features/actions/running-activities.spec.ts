import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runningActivities } from './running-activities.js';

const base = { development: [], agents: [], gitFix: null, slots: [], project: 'dev-log' };

test('Läuft gerade: freigegebene Aufträge warten auf den Merge, offene Freigaben nicht', () => {
  const activities = runningActivities({
    ...base,
    development: [
      { id: '1', title: 'Lagerverwaltung', status: 'approval', reviewApprovedAt: '2026-10-22T16:00:00Z' },
      { id: '2', title: 'Checklisten', status: 'approval', reviewApprovedAt: null },
      { id: '3', title: 'Fertig', status: 'done', reviewApprovedAt: '2026-10-22T15:00:00Z' },
    ],
  });
  assert.deepEqual(
    activities.map((activity) => [activity.kind, activity.label, activity.detail.split(' · ')[0]]),
    [['git', 'Freigegeben – wird gemergt', 'Lagerverwaltung']],
  );
});

test('Läuft gerade: Git-Lösung, aktive Agents und startende Review-Container dieses Projekts', () => {
  const activities = runningActivities({
    ...base,
    gitFix: 'Zwischenstand sichern',
    agents: [
      { id: 'a', name: 'Entwickler', active: true, sprintName: 'Sprint 20', orderTitle: 'Push-Abos absichern' },
      { id: 'b', name: 'Tester', active: false, sprintName: null, orderTitle: null },
    ],
    slots: [
      { slot: 1, status: 'starting', label: 'Checklisten-API', projectSlug: 'dev-log' },
      { slot: 2, status: 'running', label: 'Schon offen', projectSlug: 'dev-log' },
      { slot: 3, status: 'starting', label: 'Anderes Projekt', projectSlug: 'mainty' },
    ],
  });
  assert.deepEqual(
    activities.map((activity) => [activity.kind, activity.label]),
    [
      ['git', 'Git-Lösung läuft'],
      ['agent', 'Entwickler arbeitet'],
      ['user', 'Review 1 startet'],
    ],
  );
  assert.equal(runningActivities(base).length, 0, 'nichts los: Bereich bleibt unsichtbar');
});
