import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { AcceptanceCheck } from '../core/models.js';
import { AcceptanceTicks } from './acceptance-ticks.js';

const check = { kind: 'manual', position: 2, text: 'Knopf prüfen' } as unknown as AcceptanceCheck;

/** Wie `store.perform`: Fehler werden geschluckt, das Ergebnis sagt, ob es geklappt hat. */
function perform(action: () => Promise<unknown>): Promise<boolean> {
  return action().then(
    () => true,
    () => false,
  );
}

for (const [name, failure] of [
  ['403', Object.assign(new Error('Keine Berechtigung.'), { status: 403 })],
  ['409', Object.assign(new Error('Punkt schon geprüft.'), { status: 409 })],
  ['Netzfehler', new TypeError('Failed to fetch')],
] as const) {
  test(`Abnahme-Häkchen: nach ${name} wieder leer`, async () => {
    const ticks = new AcceptanceTicks();
    const box = { checked: true };
    await ticks.tick(box, 'o1', check, () => perform(() => Promise.reject(failure)));
    assert.equal(box.checked, false);
    assert.equal(ticks.saving('o1', check), false);
  });
}

test('Abnahme-Häkchen: bei Erfolg gesetzt, während des Speicherns gebunden', async () => {
  const ticks = new AcceptanceTicks();
  const box = { checked: true };
  let release!: () => void;
  const done = ticks.tick(box, 'o1', check, () => perform(() => new Promise<void>((resolve) => (release = resolve))));
  assert.equal(ticks.saving('o1', check), true);
  assert.equal(ticks.saving('o2', check), false);
  release();
  await done;
  assert.equal(box.checked, true);
  assert.equal(ticks.saving('o1', check), false);
});

test('Abnahme-Häkchen: Doppelklick sendet nur einmal', async () => {
  const ticks = new AcceptanceTicks();
  const box = { checked: true };
  let calls = 0;
  let release!: () => void;
  const first = ticks.tick(box, 'o1', check, () => {
    calls++;
    return perform(() => new Promise<void>((resolve) => (release = resolve)));
  });
  box.checked = false; // zweiter Klick schaltet im DOM wieder aus
  await ticks.tick(box, 'o1', check, async () => {
    calls++;
    return true;
  });
  assert.equal(calls, 1);
  assert.equal(box.checked, true);
  release();
  await first;
});

test('Abnahme-Häkchen: Vorlagen binden Zustand und Recht', () => {
  for (const file of [
    '../features/actions/actions.component.html',
    '../features/development/order-detail.component.html',
  ]) {
    const html = readFileSync(new URL(file, import.meta.url), 'utf8');
    const box = html.match(/<input[^>]*'Abhaken: '[^>]*>/)?.[0] ?? '';
    assert.ok(box, `Häkchen in ${file} nicht gefunden`);
    assert.doesNotMatch(box, /\[checked\]="false"/, file);
    assert.match(box, /\[checked\]="ticks\.saving\(item\.id, check\)"/, file);
    assert.match(box, /\[disabled\]="[^"]*!auth\.can\('plan'\)/, file);
    assert.match(box, /\(change\)="\w+\(\$event, item, check\)"/, file);
  }
});
