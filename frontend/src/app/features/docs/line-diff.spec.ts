import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compactDiff, lineDiff } from './line-diff.js';

const kinds = (before: string, after: string) => lineDiff(before, after).map((line) => `${line.kind[0]} ${line.text}`);

test('Zeilenvergleich: gleiche, entfernte und hinzugefügte Zeilen in Lesereihenfolge', () => {
  assert.deepEqual(kinds('a\nb\nc', 'a\nb\nc'), ['s a', 's b', 's c']);
  assert.deepEqual(kinds('a\nb\nc', 'a\nx\nc'), ['s a', 'r b', 'a x', 's c']);
  assert.deepEqual(kinds('a\nc', 'a\nb\nc'), ['s a', 'a b', 's c']);
  assert.deepEqual(kinds('a\nb\nc', 'a\nc'), ['s a', 'r b', 's c']);
  assert.deepEqual(kinds('', 'neu'), ['r ', 'a neu']);
});

test('Zeilenvergleich: längste gemeinsame Folge bleibt unverändert', () => {
  const diff = lineDiff('titel\neins\nzwei\ndrei\nende', 'titel\nzwei\ndrei\nvier\nende');
  assert.deepEqual(
    diff.filter((line) => line.kind === 'same').map((line) => line.text),
    ['titel', 'zwei', 'drei', 'ende'],
  );
  // Aus dem Ergebnis lassen sich beide Fassungen wieder herstellen.
  const before = diff.filter((line) => line.kind !== 'added').map((line) => line.text);
  const after = diff.filter((line) => line.kind !== 'removed').map((line) => line.text);
  assert.deepEqual(before, ['titel', 'eins', 'zwei', 'drei', 'ende']);
  assert.deepEqual(after, ['titel', 'zwei', 'drei', 'vier', 'ende']);
});

test('Zeilenvergleich: sehr lange Dokumente werden ohne Tabelle als ganz ersetzt gezeigt', () => {
  const long = Array.from({ length: 2001 }, (_, index) => `z${index}`).join('\n');
  const diff = lineDiff(long, `${long}\nneu`);
  assert.equal(diff.length, 2001 + 2002);
  assert.ok(diff.slice(0, 2001).every((line) => line.kind === 'removed'));
  assert.ok(diff.slice(2001).every((line) => line.kind === 'added'));
});

test('Kompakte Ansicht: nur Änderungen mit zwei Zeilen Umfeld, Rest als Lücke gezählt', () => {
  const before = Array.from({ length: 10 }, (_, index) => `z${index}`).join('\n');
  const after = before.replace('z5', 'neu');
  const compact = compactDiff(lineDiff(before, after));
  assert.deepEqual(compact, [
    { kind: 'gap', count: 3 },
    { kind: 'same', text: 'z3' },
    { kind: 'same', text: 'z4' },
    { kind: 'removed', text: 'z5' },
    { kind: 'added', text: 'neu' },
    { kind: 'same', text: 'z6' },
    { kind: 'same', text: 'z7' },
    { kind: 'gap', count: 2 },
  ]);
  assert.deepEqual(compactDiff(lineDiff('a\nb', 'a\nb')), [{ kind: 'gap', count: 2 }], 'ohne Änderung nur eine Lücke');
  assert.equal(compactDiff(lineDiff(before, after), 0).filter((line) => line.kind === 'same').length, 0);
});
