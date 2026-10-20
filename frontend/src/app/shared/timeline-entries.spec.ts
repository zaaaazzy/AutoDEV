import assert from 'node:assert/strict';
import { test } from 'node:test';
import { visibleTimelineEntries, type TimelineEntry } from './timeline-entries.js';

test('Beantwortete Rückfragen und Antworten werden ausgeblendet, offene bleiben', () => {
  const entries: TimelineEntry[] = [
    { at: '1', kind: 'created', title: 'Angelegt' },
    { at: '2', kind: 'question', title: 'Rückfrage', detail: 'Welche Farbe?', answered: true },
    { at: '3', kind: 'answer', title: 'Antwort', detail: 'Grün' },
    { at: '4', kind: 'question', title: 'Rückfrage', detail: 'Welche Schrift?', answered: false },
    { at: '5', kind: 'step', title: 'Entwickler' },
  ];
  assert.deepEqual(
    visibleTimelineEntries(entries).map((entry) => entry.at),
    ['1', '4', '5'],
  );
});
