import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ReviewSlot } from '../../core/models.js';
import {
  defaultSlot,
  showsOrder,
  slotLoadedText,
  slotOptionText,
  slotStatusText,
  slotTone,
  spawnLabel,
} from './visual-review.js';

const ORDER = '11111111-1111-4111-8111-111111111111';

function slot(values: Partial<ReviewSlot>): ReviewSlot {
  return {
    slot: 1,
    enabled: true,
    url: 'http://localhost:4201',
    status: 'idle',
    message: null,
    projectSlug: null,
    label: null,
    commit: null,
    developmentId: null,
    kind: null,
    startedAt: null,
    ...values,
  };
}

test('Umgebung: Farbe und Status je Zustand, gesperrte zuerst', () => {
  assert.equal(slotTone(slot({ enabled: false, status: 'running' })), 'off');
  assert.equal(slotTone(slot({ status: 'running' })), 'ok');
  assert.equal(slotTone(slot({ status: 'failed' })), 'error');
  assert.equal(slotTone(slot({ status: 'starting' })), 'busy');
  assert.equal(slotTone(slot({})), 'idle');
  assert.equal(slotStatusText(slot({ enabled: false })), 'gesperrt');
  assert.equal(slotStatusText(slot({})), 'frei');
  assert.equal(
    slotStatusText(slot({ status: 'failed', message: 'npm ci scheiterte\nDetails' })),
    'Fehler: npm ci scheiterte',
  );
});

test('Umgebung: geladener Stand mit Commit, fremdes Projekt ohne Inhalt', () => {
  assert.equal(slotLoadedText(slot({})), 'kein Stand geladen');
  assert.equal(
    slotLoadedText(slot({ status: 'running', projectSlug: 'e2e', label: 'Abnahme: Login', commit: 'abcdef1234' })),
    'Abnahme: Login · abcdef1',
  );
  assert.equal(
    slotLoadedText(slot({ status: 'requested', projectSlug: 'e2e', label: 'Abnahme: Login' })),
    'Abnahme: Login · Stand wird beim Start bestimmt',
  );
  assert.equal(slotLoadedText(slot({ status: 'running' })), 'belegt von einem anderen Projekt');
});

test('Umgebung: dieser Auftrag wird erkannt und vorausgewählt', () => {
  const running = slot({ slot: 2, status: 'running', projectSlug: 'e2e', developmentId: ORDER });
  assert.ok(showsOrder(running, ORDER));
  assert.equal(showsOrder({ ...running, status: 'stopping' }, ORDER), false);
  assert.equal(slotOptionText(running, ORDER), 'Umgebung 2 – Review läuft · dieser Auftrag');

  const free = slot({ slot: 3 });
  const busy = slot({ slot: 1, status: 'running', projectSlug: 'e2e' });
  const locked = slot({ slot: 4, enabled: false });
  assert.equal(defaultSlot([busy, running, free], ORDER), 2, 'Umgebung mit dem Auftrag');
  assert.equal(defaultSlot([locked, busy, free], ORDER), 3, 'sonst eine freie');
  assert.equal(defaultSlot([locked, busy], ORDER), 1, 'sonst die erste freigegebene');
  assert.equal(defaultSlot([locked], ORDER), null);
});

test('Start-Knopf: laden, ersetzen oder neu laden', () => {
  assert.equal(spawnLabel(null, ORDER), '▶ Auftrag laden');
  assert.equal(spawnLabel(slot({}), ORDER), '▶ Auftrag laden');
  assert.equal(
    spawnLabel(slot({ status: 'running', projectSlug: 'e2e' }), ORDER),
    '▶ Auftrag laden (ersetzt den Stand)',
  );
  assert.equal(spawnLabel(slot({ status: 'running', developmentId: ORDER }), ORDER), '↻ Neu laden');
  assert.equal(spawnLabel(slot({ status: 'failed', developmentId: ORDER }), ORDER), '↻ Erneut starten');
});
