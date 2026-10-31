import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { sharedPoll } from './shared-poll.js';

/** Ersatz für visibleInterval: zählt laufende Takte, `fire()` löst alle aus. */
function fakeInterval() {
  const running = new Set<() => void>();
  return {
    running,
    fire: () => running.forEach((tick) => tick()),
    interval: (tick: () => void) => {
      running.add(tick);
      return () => running.delete(tick);
    },
  };
}

test('Gemeinsamer Poll: mehrere Abnehmer teilen sich einen Takt', () => {
  const timers = fakeInterval();
  const tick = mock.fn();
  const poll = sharedPoll(tick, 5000, timers.interval, () => false);

  const first = poll.subscribe();
  const second = poll.subscribe();
  const third = poll.subscribe();
  assert.equal(tick.mock.callCount(), 1, 'nur die erste Anmeldung lädt sofort');
  assert.equal(timers.running.size, 1, 'genau ein Takt für drei Abnehmer');

  timers.fire();
  assert.equal(tick.mock.callCount(), 2, 'ein Abruf je Takt, nicht je Abnehmer');

  first();
  first();
  second();
  assert.equal(poll.subscribers, 1, 'doppeltes Abmelden zählt nur einmal');
  assert.equal(timers.running.size, 1);
  third();
  assert.equal(poll.subscribers, 0);
  assert.equal(timers.running.size, 0, 'der letzte Abnehmer beendet den Takt');
});

test('Gemeinsamer Poll: nach dem Abmelden aller startet die nächste Anmeldung neu', () => {
  const timers = fakeInterval();
  const tick = mock.fn();
  const poll = sharedPoll(tick, 5000, timers.interval, () => false);

  poll.subscribe()();
  poll.subscribe();
  assert.equal(tick.mock.callCount(), 2);
  assert.equal(timers.running.size, 1);
});

test('Gemeinsamer Poll: bei verborgenem Tab kein sofortiger Abruf', () => {
  const timers = fakeInterval();
  const tick = mock.fn();
  const poll = sharedPoll(tick, 5000, timers.interval, () => true);

  poll.subscribe();
  assert.equal(tick.mock.callCount(), 0, 'visibleInterval lädt beim Sichtbarwerden nach');
  assert.equal(timers.running.size, 1);
});
