import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computed, signal } from '@angular/core';
import { pickInOrder, poolOpenState } from './pool-selection.js';

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
