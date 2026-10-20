import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatDuration, previewText, scheduleFrom } from './agent-task-schedule.js';

const now = new Date('2026-10-20T10:00:00Z'); // Dienstag, 12:00 Zürich

test('Zeitplan aus der Auswahl: täglich, wöchentlich, eigener Cron, keiner', () => {
  assert.deepEqual(scheduleFrom('none', '07:00', 1, ''), { schedule: null, error: null });
  assert.deepEqual(scheduleFrom('daily', '07:00', 1, ''), { schedule: '0 7 * * *', error: null });
  assert.deepEqual(scheduleFrom('weekly', '07:00', 1, ''), { schedule: '0 7 * * 1', error: null });
  assert.deepEqual(scheduleFrom('custom', '', 1, ' */15  22-23 * * * '), { schedule: '*/15 22-23 * * *', error: null });
  assert.match(scheduleFrom('custom', '', 1, '0 7 * *').error ?? '', /5 Felder/);
  assert.match(scheduleFrom('daily', '', 1, '').error ?? '', /HH:MM/);
});

test('Vorschau „nächster Lauf“ in Europe/Zurich, auch über die Zeitumstellung', () => {
  // Montag 26.10. ist schon Winterzeit: 07:00 bleibt 07:00 Ortszeit.
  assert.equal(previewText('0 7 * * 1', '', now), 'nächster Lauf: Mo 07:00');
  assert.equal(previewText(null, '', now), 'Ohne Zeitplan – nur per Klick.');
  assert.equal(previewText('0 * * * *', '22:00-06:00', now), 'nächster Lauf: Di 22:00');
  assert.match(previewText('0 7 * * *', '22-6', now), /HH:MM/);
  assert.equal(previewText('0 0 30 2 *', '', now), 'Der Zeitplan trifft nie zu.');
});

test('Dauer kurz', () => {
  assert.equal(formatDuration(null), '–');
  assert.equal(formatDuration(42_000), '42 s');
  assert.equal(formatDuration(185_000), '3 min 5 s');
});
