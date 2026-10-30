import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ReviewSlot } from '../../core/models.js';
import {
  defaultSlot,
  showsOrder,
  slotErrorHint,
  slotErrorLog,
  slotLoadedText,
  slotOptionText,
  slotStatusText,
  slotTone,
  spawnLabel,
  visualStatus,
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
  const broken = slot({ slot: 5, status: 'failed', projectSlug: 'e2e' });
  assert.equal(defaultSlot([locked, busy, broken], ORDER), 5, 'sonst eine fehlerhafte statt einer belegten');
  assert.equal(defaultSlot([locked, busy], ORDER), 1, 'sonst die erste freigegebene');
  assert.equal(defaultSlot([locked], ORDER), null);
});

test('Start-Knopf: sagt, was passiert', () => {
  assert.equal(spawnLabel(null, ORDER), '▶ Auftrag laden');
  assert.equal(spawnLabel(slot({}), ORDER), '▶ Auftrag laden');
  assert.equal(
    spawnLabel(slot({ status: 'running', projectSlug: 'e2e' }), ORDER),
    '▶ Auftrag laden (ersetzt den Stand)',
  );
  assert.equal(spawnLabel(slot({ status: 'failed', projectSlug: 'e2e' }), ORDER), '▶ Auftrag laden');
  assert.equal(spawnLabel(slot({ status: 'running', developmentId: ORDER }), ORDER), '↻ Auftrag neu laden');
  assert.equal(spawnLabel(slot({ status: 'failed', developmentId: ORDER }), ORDER), '↻ Umgebung neu starten');
});

test('Fehlerhafte Umgebung erklärt sich und nennt die eine sinnvolle Aktion', () => {
  const ended = slot({ status: 'failed', message: 'Container beendet.\nnpm ERR! boom' });
  assert.match(slotErrorHint(ended, true), /hat sich beendet.*„Umgebung neu starten“/);
  assert.match(slotErrorHint(ended, false), /„Aufräumen“/);
  assert.equal(slotErrorHint(slot({ status: 'running' }), true), '');
  assert.equal(slotErrorLog(ended), 'npm ERR! boom');
  assert.equal(slotErrorLog(slot({ status: 'failed', message: 'Kein Commit gewählt.' })), '');
});

test('Statuszeile: Zustand und nächster Schritt, Freigeben nur, wo es Sinn ergibt', () => {
  const base = { approved: false, orderStatus: 'approval' as const, own: null, hasSlots: true };
  const approved = visualStatus({ ...base, approved: true, own: { slot: 1, status: 'failed', message: null } });
  assert.equal(approved.tone, 'done');
  assert.match(approved.title, /nichts zu tun/);
  assert.equal(approved.canApprove, false);

  const blocked = visualStatus({ ...base, orderStatus: 'blocked' });
  assert.equal(blocked.canApprove, false, 'nicht freigeben und erneut versuchen nebeneinander');
  assert.match(blocked.next, /„Erneut versuchen“/);
  assert.equal(visualStatus({ ...base, orderStatus: 'in_progress' }).canApprove, false);

  const failed = visualStatus({ ...base, own: { slot: 2, status: 'failed', message: 'Container beendet.' } });
  assert.equal(failed.tone, 'error');
  assert.equal(failed.title, 'Umgebung 2 fehlerhaft – neu starten.');

  assert.equal(visualStatus({ ...base, own: { slot: 1, status: 'starting', message: null } }).tone, 'wait');
  assert.equal(
    visualStatus({ ...base, own: { slot: 3, status: 'running', message: null } }).title,
    'Bitte in Umgebung 3 ansehen und freigeben.',
  );
  assert.equal(visualStatus(base).title, 'Bitte ansehen und freigeben.');
  assert.match(visualStatus({ ...base, hasSlots: false }).next, /keine Umgebung eingerichtet/);
});
