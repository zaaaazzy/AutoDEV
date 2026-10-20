import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LoopGuard } from './loop-guard.js';

const paragraph = (text: string): string => `${text} – ein Absatz, der lang genug ist, um zu zählen.`;

test('repeatedText: dieselbe Zeile dreimal direkt hintereinander ist eine Schleife', () => {
  const guard = new LoopGuard();
  const line = paragraph('Ich prüfe jetzt die Datei');
  assert.equal(guard.repeatedText([line, line].join('\n')), null, 'zweimal ist noch keine Schleife');
  assert.equal(guard.repeatedText([line, line, line].join('\n')), line);
  // Leerzeilen trennen Absätze, unterbrechen die Folge aber nicht.
  assert.equal(guard.repeatedText([line, '', line, '\n\n', line].join('\n')), line);
});

test('repeatedText: Leerzeichen werden vereinheitlicht und die Meldung auf 120 Zeichen gekürzt', () => {
  const guard = new LoopGuard();
  const long = paragraph('x'.repeat(200));
  const result = guard.repeatedText([long, `  ${long.replace(' ', '   ')}  `, long].join('\n'));
  assert.equal(result, long.slice(0, 120));
});

test('repeatedText: achtmal im ganzen Text ist eine Schleife, siebenmal nicht', () => {
  const guard = new LoopGuard();
  const line = paragraph('- **Timeout**: Standardwert für jeden Endpunkt');
  const text = (times: number): string =>
    Array.from({ length: times }, (_, index) => `${line}\n${paragraph(`Abschnitt ${index}`)}`).join('\n');
  assert.equal(guard.repeatedText(text(7)), null);
  assert.equal(guard.repeatedText(text(8)), line);
});

test('repeatedText: kurze Zeilen und reine Trennlinien zählen nicht und unterbrechen die Folge', () => {
  const guard = new LoopGuard();
  assert.equal(guard.repeatedText(['ok', 'ok', 'ok', 'ok'].join('\n')), null);
  const ruler = '='.repeat(60);
  const table = '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |';
  assert.equal(guard.repeatedText([ruler, ruler, ruler, table, table, table].join('\n')), null);
  const line = paragraph('Zwischen den Wiederholungen steht ein Trenner');
  assert.equal(guard.repeatedText([line, line, ruler, line].join('\n')), null);
  assert.equal(guard.repeatedText(''), null);
});

test('repeatedCall: derselbe Aufruf viermal direkt hintereinander, andere Argumente setzen zurück', () => {
  const guard = new LoopGuard();
  const args = { path: '.' };
  assert.equal(guard.repeatedCall('list_files', args), false);
  assert.equal(guard.repeatedCall('list_files', args), false);
  assert.equal(guard.repeatedCall('list_files', args), false);
  assert.equal(guard.repeatedCall('list_files', { path: '.' }), true);
  assert.equal(guard.repeatedCall('list_files', args), true, 'bleibt eine Schleife, solange sie andauert');
  assert.equal(guard.repeatedCall('list_files', { path: 'src' }), false);
  assert.equal(guard.repeatedCall('read_file', { path: 'src' }), false);
  // Zwei Wächter teilen keinen Zustand.
  assert.equal(new LoopGuard().repeatedCall('list_files', args), false);
});
