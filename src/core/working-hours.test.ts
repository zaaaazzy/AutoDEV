import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeWorkingHours, isValidWorkingHours, withinWorkingHours } from './working-hours.js';

// 2026-10-19 ist ein Montag.
const at = (day: number, time: string): Date => new Date(`2026-10-${String(18 + day).padStart(2, '0')}T${time}:00`);

test('Arbeitszeiten: nur im Fenster und an den gewählten Tagen', () => {
  const office = { start: '08:00', end: '18:00', days: [1, 2, 3, 4, 5] };
  assert.equal(withinWorkingHours(at(1, '08:00'), office), true);
  assert.equal(withinWorkingHours(at(1, '17:59'), office), true);
  assert.equal(withinWorkingHours(at(1, '18:00'), office), false);
  assert.equal(withinWorkingHours(at(1, '07:59'), office), false);
  assert.equal(withinWorkingHours(at(6, '10:00'), office), false);
});

test('Arbeitszeiten über Mitternacht gehören zum Starttag; gleiche Zeiten = ganztägig', () => {
  const night = { start: '22:00', end: '06:00', days: [5] };
  assert.equal(withinWorkingHours(at(5, '23:00'), night), true);
  assert.equal(withinWorkingHours(at(6, '05:00'), night), true);
  assert.equal(withinWorkingHours(at(5, '05:00'), night), false);
  assert.equal(withinWorkingHours(at(6, '23:00'), night), false);
  // Sonntag 23 Uhr bis Montag früh.
  assert.equal(withinWorkingHours(at(1, '01:00'), { start: '22:00', end: '06:00', days: [7] }), true);
  assert.equal(withinWorkingHours(at(7, '03:00'), { start: '00:00', end: '00:00', days: [7] }), true);
});

test('Arbeitszeiten prüfen und beschreiben', () => {
  assert.equal(isValidWorkingHours({ start: '08:00', end: '18:00', days: [1, 2] }), true);
  assert.equal(isValidWorkingHours({ start: '8:00', end: '18:00', days: [1] }), false);
  assert.equal(isValidWorkingHours({ start: '08:00', end: '24:00', days: [1] }), false);
  assert.equal(isValidWorkingHours({ start: '08:00', end: '18:00', days: [] }), false);
  assert.equal(isValidWorkingHours({ start: '08:00', end: '18:00', days: [0] }), false);
  assert.equal(describeWorkingHours({ start: '08:00', end: '18:00', days: [1, 2, 3, 4, 5] }), 'Mo–Fr 08:00–18:00');
  assert.equal(describeWorkingHours({ start: '08:00', end: '12:00', days: [3, 1] }), 'Mo, Mi 08:00–12:00');
  assert.equal(
    describeWorkingHours({ start: '00:00', end: '00:00', days: [1, 2, 3, 4, 5, 6, 7] }),
    'täglich 00:00–00:00',
  );
});
