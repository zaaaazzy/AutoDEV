import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { visibleInterval, type VisibilitySource } from './visible-interval.js';

class FakeDocument extends EventTarget implements VisibilitySource {
  hidden = false;
  listeners = 0;
  override addEventListener(type: 'visibilitychange', listener: () => void): void {
    this.listeners += 1;
    super.addEventListener(type, listener);
  }
  override removeEventListener(type: 'visibilitychange', listener: () => void): void {
    this.listeners -= 1;
    super.removeEventListener(type, listener);
  }
  setHidden(hidden: boolean): void {
    this.hidden = hidden;
    this.dispatchEvent(new Event('visibilitychange'));
  }
}

test('Polling pausiert in verborgenen Tabs und lädt beim Zurückkehren sofort nach', (context) => {
  context.mock.timers.enable({ apis: ['setInterval'] });
  const doc = new FakeDocument();
  const tick = mock.fn();
  const stop = visibleInterval(tick, 1000, doc);

  context.mock.timers.tick(3000);
  assert.equal(tick.mock.callCount(), 3);

  doc.setHidden(true);
  context.mock.timers.tick(10_000);
  assert.equal(tick.mock.callCount(), 3, 'kein Polling, solange der Tab verborgen ist');

  doc.setHidden(false);
  assert.equal(tick.mock.callCount(), 4, 'sofort nachladen beim Sichtbarwerden');
  context.mock.timers.tick(1000);
  assert.equal(tick.mock.callCount(), 5);

  stop();
  context.mock.timers.tick(5000);
  assert.equal(tick.mock.callCount(), 5);
  assert.equal(doc.listeners, 0, 'Listener wird beim Aufräumen entfernt');
});

test('Startet ein Tab verborgen, wird erst beim Sichtbarwerden gepollt', (context) => {
  context.mock.timers.enable({ apis: ['setInterval'] });
  const doc = new FakeDocument();
  doc.hidden = true;
  const tick = mock.fn();
  const stop = visibleInterval(tick, 1000, doc);
  context.mock.timers.tick(5000);
  assert.equal(tick.mock.callCount(), 0);
  doc.setHidden(false);
  doc.setHidden(false);
  assert.equal(tick.mock.callCount(), 1, 'doppeltes Ereignis startet keinen zweiten Timer');
  context.mock.timers.tick(1000);
  assert.equal(tick.mock.callCount(), 2);
  stop();
});
