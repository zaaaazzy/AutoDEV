import assert from 'node:assert/strict';
import { test } from 'node:test';
import { signal } from '@angular/core';
import { exclusive, sprintButtons } from './sprint-actions.js';

const all = () => true;
const only = (role: 'plan' | 'run') => (wanted: 'plan' | 'run') => wanted === role;

test('Sprint starten: nur geplant, mit „Planung“; anderer aktiver Sprint sperrt mit Grund', () => {
  const planned = { id: 's1', status: 'planned' };
  assert.equal(sprintButtons(planned, [planned], [], all).start, true);
  assert.equal(sprintButtons(planned, [planned], [], all).activateBlocked, null);
  const other = { id: 's2', status: 'active' };
  const blocked = sprintButtons(planned, [planned, other], [], all);
  assert.equal(blocked.start, true, 'anderer aktiv: sichtbar');
  assert.match(blocked.activateBlocked ?? '', /nur ein Sprint/);
  assert.equal(sprintButtons(planned, [planned], [], only('run')).start, false, 'ohne Planung');
  assert.equal(sprintButtons(planned, [planned, other], [], only('run')).activateBlocked, null, 'ohne Knopf kein Grund');
  for (const status of ['active', 'review', 'completed', 'cancelled']) {
    assert.equal(sprintButtons({ id: 's1', status }, [], [], all).start, false, status);
  }
});

test('Wieder öffnen: nur abgeschlossen; anderer aktiver Sprint sperrt mit Grund', () => {
  const done = { id: 's1', status: 'completed' };
  assert.equal(sprintButtons(done, [done], [], all).reopen, true);
  const blocked = sprintButtons(done, [done, { id: 's2', status: 'active' }], [], all);
  assert.equal(blocked.reopen, true);
  assert.match(blocked.activateBlocked ?? '', /nur ein Sprint/);
  assert.equal(sprintButtons({ id: 's1', status: 'review' }, [], [], all).reopen, false, 'Review: Worker');
});

test('Live schalten: nur aktiv mit „Planung“; laufende oder freizugebende Aufträge nennen den Grund', () => {
  const active = { id: 's1', status: 'active' };
  const free = sprintButtons(active, [active], [{ sprintId: 's1', status: 'done' }], all);
  assert.equal(free.live, true);
  assert.equal(free.liveBlocked, null);
  const running = sprintButtons(active, [active], [{ sprintId: 's1', status: 'in_progress' }], all);
  assert.match(running.liveBlocked ?? '', /laufen noch Aufträge/);
  const waiting = sprintButtons(active, [active], [{ sprintId: 's1', status: 'approval' }], all);
  assert.match(waiting.liveBlocked ?? '', /Review-Freigabe/);
  assert.equal(sprintButtons(active, [active], [{ sprintId: 'x', status: 'in_progress' }], all).liveBlocked, null);
  assert.equal(sprintButtons(active, [active], [], only('run')).live, false);
  assert.equal(sprintButtons({ id: 's1', status: 'planned' }, [], [], all).live, false);
});

test('Löschen: nur geplant, abgeschlossen oder abgebrochen, ohne Git-Sicherung und ohne laufende Aufträge', () => {
  for (const status of ['planned', 'completed', 'cancelled']) {
    assert.equal(sprintButtons({ id: 's1', status }, [], [], all).remove, true, status);
  }
  for (const status of ['active', 'review']) {
    assert.equal(sprintButtons({ id: 's1', status }, [], [], all).remove, false, status);
  }
  const planned = { id: 's1', status: 'planned' };
  assert.equal(sprintButtons({ ...planned, gitSync: 'running' }, [], [], all).remove, false, 'Git läuft');
  assert.equal(sprintButtons({ ...planned, gitSync: 'awaiting_merge' }, [], [], all).remove, true);
  assert.equal(sprintButtons(planned, [], [{ sprintId: 's1', status: 'approval' }], all).remove, false);
  assert.equal(sprintButtons(planned, [], [], only('run')).remove, false, 'ohne Planung');
});

test('Pausieren/Fortsetzen brauchen „Ausführen“, Abbrechen und Wieder planen „Planung“', () => {
  const active = { id: 's1', status: 'active' };
  assert.equal(sprintButtons(active, [], [], only('run')).pause, true);
  assert.equal(sprintButtons(active, [], [], only('plan')).pause, false);
  assert.equal(sprintButtons({ ...active, pausedAt: '2026-10-28' }, [], [], only('run')).resume, true);
  assert.equal(sprintButtons(active, [], [], only('plan')).cancel, true);
  assert.equal(sprintButtons(active, [], [], only('run')).cancel, false);
  assert.equal(sprintButtons({ id: 's1', status: 'cancelled' }, [], [], only('plan')).replan, true);
  assert.equal(sprintButtons({ id: 's1', status: 'cancelled' }, [], [], only('plan')).cancel, false);
  assert.equal(sprintButtons(active, [], [], only('run')).edit, false);
});

test('Doppelklick auf „Sprint starten“ schickt nur einen PATCH', async () => {
  const acting = signal(false);
  let patches = 0;
  let answer!: () => void;
  async function start(): Promise<void> {
    await exclusive(acting, async () => {
      // Rückfrage und PATCH dauern: der zweite Klick kommt dazwischen.
      await new Promise<void>((resolve) => (answer = resolve));
      patches += 1;
    });
  }
  const first = start();
  const second = start();
  assert.equal(acting(), true);
  answer();
  await Promise.all([first, second]);
  assert.equal(patches, 1);
  assert.equal(acting(), false);
});

test('Nach einem Fehler sind die Knöpfe wieder frei', async () => {
  const acting = signal(false);
  const failing = exclusive(acting, async () => {
    throw new Error('409');
  });
  await assert.rejects(failing);
  assert.equal(acting(), false);
});
