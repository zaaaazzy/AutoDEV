import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DocumentEntry } from '../../core/models.js';
import { closeEnough, normalize, searchDocs, tokenize } from './doc-search.js';

const doc = (id: string, title: string, content: string): DocumentEntry => ({
  id,
  kind: 'manual',
  title,
  content,
  sprintId: null,
  updatedAt: '2026-10-22T10:00:00Z',
});

test('Suche: Umlaute, Akzente und Grossschreibung werden vereinheitlicht', () => {
  assert.equal(normalize('Größe Übersicht Café'), 'groesse uebersicht cafe');
  assert.deepEqual(
    tokenize('Größe, größe  & a Übersicht!'),
    ['groesse', 'uebersicht'],
    'doppelte und 1-Zeichen-Wörter weg',
  );
  assert.deepEqual(tokenize(' - '), []);
});

test('Suche: Tippfehler-Toleranz ist genau ein Zeichen', () => {
  assert.ok(closeEnough('sprint', 'sprint'));
  assert.ok(closeEnough('sprint', 'spirnt') === false, 'Vertauschung sind zwei Änderungen');
  assert.ok(closeEnough('sprint', 'sprnt'));
  assert.ok(closeEnough('sprint', 'sprints'));
  assert.ok(closeEnough('sprint', 'sprant'));
  assert.equal(closeEnough('sprint', 'spr'), false);
  assert.equal(closeEnough('sprint', 'sbrant'), false);
});

test('Suche: Titel und Überschriften zählen mehr, alle Begriffe gefunden zuerst', () => {
  const docs = [
    doc('text', 'Allgemein', 'Hier steht etwas über Sprint und Planung im Fliesstext.'),
    doc('titel', 'Sprint-Planung', 'Kurz.'),
    doc('halb', 'Sprint', 'Nur der eine Begriff.'),
    doc('nichts', 'Agents', 'Keine Treffer hier.'),
  ];
  const hits = searchDocs(docs, 'sprint planung');
  assert.deepEqual(
    hits.map((hit) => hit.doc.id),
    ['titel', 'text', 'halb'],
  );
  assert.deepEqual(searchDocs(docs, 'x'), [], 'zu kurze Suche findet nichts');
});

test('Suche: Ausschnitte markieren Treffer und escapen den Text', () => {
  const [hit] = searchDocs([doc('a', 'Hilfe', 'Vorher <script>alert(1)</script> Größe danach')], 'groesse');
  assert.ok(hit);
  assert.equal(hit.snippets.length, 1);
  assert.match(hit.snippets[0]!, /<mark>Größe<\/mark>/, 'Markierung im Originaltext, auch bei Umlaut');
  assert.doesNotMatch(hit.snippets[0]!, /<script>/);
  assert.match(hit.snippets[0]!, /&lt;script/);
});

test('Suche: Tippfehler in längeren Wörtern findet trotzdem, Markdown stört die Ausschnitte nicht', () => {
  const [hit] = searchDocs(
    [doc('a', 'Handbuch', '## Abschnitt\n\n**Autopilot** freigeben\n\n```\ncode\n```')],
    'autopilt',
  );
  assert.ok(hit);
  assert.match(hit.snippets[0]!, /<mark>Autopilot<\/mark> freigeben/);
  assert.doesNotMatch(hit.snippets[0]!, /\*\*|```/);
});

test('Suche: höchstens drei Ausschnitte je Dokument und 30 Treffer insgesamt', () => {
  const long = Array.from({ length: 20 }, (_, index) => `Absatz ${index} ${'füllt '.repeat(30)} Treffer`).join('\n');
  const [hit] = searchDocs([doc('a', 'Lang', long)], 'treffer');
  assert.equal(hit!.snippets.length, 3);
  assert.ok(hit!.snippets[0]!.startsWith('… '));
  const many = Array.from({ length: 40 }, (_, index) => doc(String(index), `Treffer ${index}`, ''));
  assert.equal(searchDocs(many, 'treffer').length, 30);
});
