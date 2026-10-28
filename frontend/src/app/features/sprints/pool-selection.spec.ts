import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computed, signal } from '@angular/core';
import { canTakeIntoSprint } from '../../../../../src/core/development-transitions.js';
import { NEEDS_RUN, pickInOrder, poolOpenState, poolSelectable } from './pool-selection.js';

test('Auswahl: in Anzeige-Reihenfolge, nicht mehr verfügbare fallen weg', () => {
  const items = [{ id: 'c' }, { id: 'a' }, { id: 'b' }];
  assert.deepEqual(
    pickInOrder(items, new Set(['b', 'c', 'weg'])).map((item) => item.id),
    ['c', 'b'],
  );
});

interface Item {
  id: string;
  sprintId?: string;
}

/** Nachbau von store.data() und SprintOrdersComponent.orders(): jedes Nachladen liefert neue Arrays. */
function sprintView(items: Item[]) {
  const data = signal({ development: items, agentRuns: [] as { id: string }[] });
  const orders = computed(() => data().development.filter((item) => item.sprintId === 's1'));
  const free = computed(() => data().development.filter((item) => !item.sprintId));
  return { data, orders, free, poolOpen: poolOpenState(() => orders()) };
}

test('„Aufträge hinzufügen“: anfangs offen bei leerem Sprint, sonst zu', () => {
  assert.equal(sprintView([{ id: 'a' }]).poolOpen(), true);
  assert.equal(sprintView([{ id: 'a' }, { id: 'b', sprintId: 's1' }]).poolOpen(), false);
});

test('„Aufträge hinzufügen“: von Hand geöffnet bleibt offen beim Refresh der Agent-Läufe und nach Übernahme', () => {
  const view = sprintView([{ id: 'a' }, { id: 'b' }, { id: 'c', sprintId: 's1' }]);
  assert.equal(view.poolOpen(), false);
  view.poolOpen.set(true);
  const selected = new Set(['a', 'b']);

  // Live-Refresh: neue Arrays, gleicher Inhalt, nur agentRuns geändert.
  view.data.update((data) => ({
    development: data.development.map((item) => ({ ...item })),
    agentRuns: [{ id: 'r1' }],
  }));
  assert.equal(view.poolOpen(), true);
  assert.deepEqual(
    pickInOrder(view.free(), selected).map((item) => item.id),
    ['a', 'b'],
  );

  // „→“: Auftrag a ist übernommen; die Liste bleibt offen, a fällt aus der Auswahl.
  view.data.update((data) => ({
    ...data,
    development: data.development.map((item) => (item.id === 'a' ? { ...item, sprintId: 's1' } : item)),
  }));
  assert.equal(view.poolOpen(), true);
  assert.deepEqual(
    pickInOrder(view.free(), selected).map((item) => item.id),
    ['b'],
  );
});

test('„Aufträge hinzufügen“: Wechsel leer ↔ nicht leer setzt auf die Vorgabe zurück', () => {
  const view = sprintView([{ id: 'a' }, { id: 'b' }]);
  assert.equal(view.poolOpen(), true);
  view.poolOpen.set(false);

  // Refresh im leeren Sprint ändert die Wahl des Nutzers nicht.
  view.data.update((data) => ({ ...data, development: [...data.development] }));
  assert.equal(view.poolOpen(), false);

  // Erster Auftrag im Sprint: Vorgabe „zu“.
  view.data.update((data) => ({ ...data, development: [{ id: 'a', sprintId: 's1' }, { id: 'b' }] }));
  assert.equal(view.poolOpen(), false);

  // Sprint wieder leer: Vorgabe „offen“.
  view.data.update((data) => ({ ...data, development: [{ id: 'a' }, { id: 'b' }] }));
  assert.equal(view.poolOpen(), true);
});

test('„Aufträge hinzufügen“: abgebrochene nur mit „Ausführen“ wählbar, offene schon mit „Planung“', () => {
  const open = { id: 'o', status: 'backlog', removedFromSprintAt: null };
  const blocked = { id: 'b', status: 'blocked', removedFromSprintAt: null };
  const removed = { id: 'r', status: 'backlog', removedFromSprintAt: '2026-10-21' };
  const plannerOnly = poolSelectable(() => false);
  assert.equal(plannerOnly(open), true, 'offen mit Planung');
  assert.equal(plannerOnly(blocked), false, 'blockiert ohne Ausführen');
  assert.equal(plannerOnly(removed), false, 'herausgenommen ohne Ausführen');
  const runner = poolSelectable(() => true);
  for (const item of [open, blocked, removed]) assert.equal(runner(item), true, item.id);
  assert.match(NEEDS_RUN, /Agents ausführen/);
});

test('„Aufträge hinzufügen“: nach Rollenwechsel bleibt keine angehakte, nun gesperrte Auswahl übrig', () => {
  const canRun = signal(true);
  const selectable = poolSelectable(() => canRun());
  const free = [
    { id: 'o', status: 'backlog', removedFromSprintAt: null },
    { id: 'b', status: 'blocked', removedFromSprintAt: null },
  ];
  // Wie SprintOrdersComponent.selection.
  const selection = computed(() => pickInOrder(free.filter(selectable), new Set(['o', 'b'])).map((item) => item.id));
  assert.deepEqual(selection(), ['o', 'b']);
  canRun.set(false);
  assert.deepEqual(selection(), ['o'], 'blockierter fällt ohne Ausführen aus der Auswahl');
  canRun.set(true);
  assert.deepEqual(selection(), ['o', 'b']);
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
