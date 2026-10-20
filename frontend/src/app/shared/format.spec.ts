import assert from 'node:assert/strict';
import { test } from 'node:test';

// Feste Zeitzone für die Tests: MESZ (UTC+2) bzw. MEZ (UTC+1).
process.env['TZ'] = 'Europe/Zurich';
const { formatIsoDate, localDateKey } = await import('./format.js');

test('Datum: Zeitstempel kurz nach Mitternacht Ortszeit zählt zum lokalen Tag', () => {
  // 21.10.2026 01:30 MESZ = 20.10.2026 23:30 UTC
  assert.equal(formatIsoDate('2026-10-20T23:30:00.000Z'), '21.10.2026');
  assert.equal(localDateKey('2026-10-20T23:30:00Z'), '2026-10-21');
  // Winterzeit: 01.01.2027 00:30 MEZ = 31.12.2026 23:30 UTC
  assert.equal(formatIsoDate('2026-12-31T23:30:00Z'), '01.01.2027');
});

test('Datum: Zeitstempel tagsüber bleibt am selben Tag', () => {
  assert.equal(formatIsoDate('2026-10-20T12:00:00Z'), '20.10.2026');
});

test('Datum: reine Daten (Sprint-Start/-Ende) werden nicht verschoben', () => {
  assert.equal(formatIsoDate('2026-10-21'), '21.10.2026');
});
