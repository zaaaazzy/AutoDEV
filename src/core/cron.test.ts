import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  describeCron,
  formatRun,
  inWindow,
  nextCronRun,
  nextRoutineRun,
  parseCron,
  parseWindow,
  simpleCron,
  zonedTime,
} from './cron.js';

const iso = (date: Date | null) => date?.toISOString() ?? null;

test('Cron: gültige Ausdrücke mit Listen, Bereichen, Schritten und Namen', () => {
  const cron = parseCron('*/15 7-9 1,15 jan-mar mon-fri');
  assert.equal(typeof cron, 'object');
  if (typeof cron === 'string') return;
  assert.deepEqual(cron.minutes, [0, 15, 30, 45]);
  assert.deepEqual(cron.hours, [7, 8, 9]);
  assert.deepEqual([...cron.months], [1, 2, 3]);
  assert.deepEqual([...cron.weekdays], [1, 2, 3, 4, 5]);
  assert.ok((parseCron('0 0 * * 7') as { weekdays: Set<number> }).weekdays.has(0), '7 = Sonntag');
});

test('Cron: ungültige Ausdrücke liefern einen Fehlertext', () => {
  for (const bad of [
    '',
    '* * * *',
    '60 * * * *',
    '* 24 * * *',
    '* * 0 * *',
    '*/0 * * * *',
    '5-1 * * * *',
    'a b c d e',
  ]) {
    assert.equal(typeof parseCron(bad), 'string', bad);
  }
});

test('Cron: nächster Lauf täglich um 07:00 in Europe/Zurich', () => {
  // 20.10.2026 08:00 Zürich (Sommerzeit, UTC+2) → morgen 07:00 = 05:00 UTC.
  assert.equal(iso(nextCronRun('0 7 * * *', new Date('2026-10-20T06:00:00Z'))), '2026-10-21T05:00:00.000Z');
  // Strikt danach: genau zur Fälligkeit zählt der nächste Tag.
  assert.equal(iso(nextCronRun('0 7 * * *', new Date('2026-10-21T05:00:00Z'))), '2026-10-22T05:00:00.000Z');
});

test('Cron: Wechsel von Sommer- auf Winterzeit (25.10.2026)', () => {
  // Vor der Umstellung 07:00 = 05:00 UTC, danach 07:00 = 06:00 UTC.
  assert.equal(iso(nextCronRun('0 7 * * *', new Date('2026-10-24T05:00:00Z'))), '2026-10-25T06:00:00.000Z');
  assert.equal(iso(nextCronRun('0 7 * * *', new Date('2026-10-25T06:00:00Z'))), '2026-10-26T06:00:00.000Z');
  // 02:30 gibt es doppelt: genau ein Lauf (der erste, 00:30 UTC), dann erst wieder am Folgetag.
  const first = nextCronRun('30 2 * * *', new Date('2026-10-24T23:00:00Z'));
  assert.equal(iso(first), '2026-10-25T00:30:00.000Z');
  assert.equal(iso(nextCronRun('30 2 * * *', first!)), '2026-10-26T01:30:00.000Z');
});

test('Cron: Wechsel auf Sommerzeit (29.03.2026) verschiebt die fehlende Uhrzeit', () => {
  // 02:30 gibt es nicht → 03:30 Sommerzeit = 01:30 UTC.
  assert.equal(iso(nextCronRun('30 2 * * *', new Date('2026-03-28T12:00:00Z'))), '2026-03-29T01:30:00.000Z');
  assert.equal(iso(zonedTime(2026, 3, 29, 3, 0)), '2026-03-29T01:00:00.000Z');
});

test('Cron: wöchentlich und Tag-oder-Wochentag wie Vixie-Cron', () => {
  // Dienstag 20.10.2026 → nächster Montag 26.10. 07:00 (Winterzeit) = 06:00 UTC.
  assert.equal(iso(nextCronRun('0 7 * * 1', new Date('2026-10-20T10:00:00Z'))), '2026-10-26T06:00:00.000Z');
  // Tag 1 ODER Freitag: Freitag 23.10. kommt zuerst.
  assert.equal(iso(nextCronRun('0 12 1 * 5', new Date('2026-10-20T10:00:00Z'))), '2026-10-23T10:00:00.000Z');
  assert.equal(nextCronRun('0 0 30 2 *', new Date('2026-01-01T00:00:00Z')), null);
});

test('Zeitfenster über Mitternacht', () => {
  assert.equal(typeof parseWindow('22-06'), 'string');
  assert.equal(parseWindow(''), null);
  // 23:00 Zürich (Winterzeit) = 22:00 UTC → im Fenster, 12:00 nicht.
  assert.equal(inWindow(new Date('2026-11-02T22:00:00Z'), '22:00-06:00'), true);
  assert.equal(inWindow(new Date('2026-11-02T11:00:00Z'), '22:00-06:00'), false);
  assert.equal(inWindow(new Date('2026-11-02T11:00:00Z'), null), true);
  // Stündlich, aber nur 22–06 Uhr: nach 12:00 kommt 22:00.
  assert.equal(
    iso(nextRoutineRun('0 * * * *', '22:00-06:00', new Date('2026-11-02T11:00:00Z'))),
    '2026-11-02T21:00:00.000Z',
  );
});

test('Vorschau und einfache Auswahl', () => {
  assert.equal(formatRun(new Date('2026-10-26T06:00:00Z'), new Date('2026-10-20T10:00:00Z')), 'Mo 07:00');
  assert.equal(formatRun(new Date('2026-12-07T06:00:00Z'), new Date('2026-10-20T10:00:00Z')), 'Mo 07.12. 07:00');
  assert.equal(simpleCron('daily', '07:05'), '5 7 * * *');
  assert.equal(simpleCron('weekly', '22:00', 1), '0 22 * * 1');
  assert.equal(simpleCron('daily', '25:00'), null);
  assert.deepEqual(describeCron('5 7 * * *'), { kind: 'daily', time: '07:05' });
  assert.deepEqual(describeCron('0 22 * * 7'), { kind: 'weekly', time: '22:00', weekday: 0 });
  assert.deepEqual(describeCron('*/5 * * * *'), { kind: 'custom' });
});
