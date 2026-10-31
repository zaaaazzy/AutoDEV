import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calibrationText, hitRateText } from './stats-text.js';

test('Trefferquote je Sprint: Prozent und „x von y“, ohne gemessene Aufträge „–“ statt 0 %', () => {
  assert.equal(hitRateText({ hits: 2, measured: 3, percent: 67 }), '67 % (2 von 3)');
  assert.equal(hitRateText({ hits: 0, measured: 1, percent: 0 }), '0 % (0 von 1)');
  assert.equal(hitRateText({ hits: 0, measured: 0, percent: null }), '–');
  assert.equal(hitRateText(undefined), '–');
});

test('Korrekturfaktor je Herkunft: Faktor und Anzahl der Messwerte, unter 5 Messwerten Faktor 1', () => {
  const entry = { source: 'author', label: 'Auftragsautor', hours: 0.25, tokens: 1.5, samples: 12 };
  assert.equal(calibrationText({ ...entry, scope: 'project' }), 'Faktor 0,25 (Stunden) / 1,5 (Tokens) · 12 Messwerte');
  assert.equal(
    calibrationText({ ...entry, scope: 'all' }),
    'Faktor 0,25 (Stunden) / 1,5 (Tokens) · 12 Messwerte, alle Projekte',
  );
  assert.equal(
    calibrationText({ ...entry, hours: 1, tokens: 1, samples: 0, scope: 'default' }),
    'Faktor 1 (unter 5 Messwerten)',
  );
});
