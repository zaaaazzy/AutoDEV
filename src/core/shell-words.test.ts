import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BACKSLASH_AT_END, joinShellLine, QUOTE_NOT_CLOSED, quoteShellWord, splitShellLine } from './shell-words.js';

test('splitShellLine: einfache Wörter, mehrfacher Leerraum und Tabs', () => {
  assert.deepEqual(splitShellLine('npm test'), ['npm', 'test']);
  assert.deepEqual(splitShellLine('  npm   run\tlint  --  --fix '), ['npm', 'run', 'lint', '--', '--fix']);
  assert.deepEqual(splitShellLine('npx tsx --test {tests}'), ['npx', 'tsx', '--test', '{tests}']);
});

test('splitShellLine: leere Zeile und nur Leerraum ergeben keine Wörter', () => {
  assert.deepEqual(splitShellLine(''), []);
  assert.deepEqual(splitShellLine('   \t '), []);
});

test('splitShellLine: doppelte Anführungszeichen gruppieren und fallen weg', () => {
  assert.deepEqual(splitShellLine('sh -c "if [ -f package.json ]; then npm test; else echo kein Code; fi"'), [
    'sh',
    '-c',
    'if [ -f package.json ]; then npm test; else echo kein Code; fi',
  ]);
  assert.deepEqual(splitShellLine('sh -c "npm run build && npm test"'), ['sh', '-c', 'npm run build && npm test']);
  assert.deepEqual(splitShellLine('echo ""'), ['echo', ''], 'leeres Argument bleibt erhalten');
  assert.deepEqual(splitShellLine('a"b c"d'), ['ab cd'], 'Anführungszeichen mitten im Wort');
});

test('splitShellLine: einfache Anführungszeichen nehmen alles wörtlich', () => {
  assert.deepEqual(splitShellLine(`sh -c 'echo "hallo welt"'`), ['sh', '-c', 'echo "hallo welt"']);
  assert.deepEqual(
    splitShellLine(`printf 'a\\n'`),
    ['printf', 'a\\n'],
    'Backslash bleibt in einfachen Anführungszeichen',
  );
  assert.deepEqual(splitShellLine(`echo '$HOME'`), ['echo', '$HOME'], 'keine Variablen-Expansion');
});

test('splitShellLine: Backslash maskiert das nächste Zeichen', () => {
  assert.deepEqual(splitShellLine('echo kein\\ Code'), ['echo', 'kein Code']);
  assert.deepEqual(splitShellLine('echo \\"x\\"'), ['echo', '"x"']);
  assert.deepEqual(splitShellLine('echo a\\\\b'), ['echo', 'a\\b']);
  assert.deepEqual(splitShellLine('sh -c "grep \\"foo\\" datei"'), ['sh', '-c', 'grep "foo" datei']);
  assert.deepEqual(splitShellLine('sh -c "echo \\$HOME"'), ['sh', '-c', 'echo $HOME']);
  assert.deepEqual(
    splitShellLine(`sh -c "printf 'a\\n'"`),
    ['sh', '-c', `printf 'a\\n'`],
    'in doppelten Anführungszeichen bleibt der Backslash vor gewöhnlichen Zeichen stehen (POSIX)',
  );
});

test('splitShellLine: Pipes, Umleitungen und Variablen bleiben gewöhnliche Wörter', () => {
  assert.deepEqual(splitShellLine('npm test | tee log.txt > out 2>&1; echo $X'), [
    'npm',
    'test',
    '|',
    'tee',
    'log.txt',
    '>',
    'out',
    '2>&1;',
    'echo',
    '$X',
  ]);
});

test('splitShellLine: unausgeglichene Anführungszeichen und Backslash am Ende sind Fehler', () => {
  assert.throws(() => splitShellLine('sh -c "npm test'), { message: QUOTE_NOT_CLOSED });
  assert.throws(() => splitShellLine("echo 'offen"), { message: QUOTE_NOT_CLOSED });
  assert.throws(() => splitShellLine('echo "a\\"'), { message: QUOTE_NOT_CLOSED });
  assert.throws(() => splitShellLine('echo a\\'), { message: BACKSLASH_AT_END });
});

test('quoteShellWord und joinShellLine: Argumente mit Leerzeichen kommen unverändert zurück', () => {
  assert.equal(quoteShellWord('npm'), 'npm');
  assert.equal(quoteShellWord('{tests}'), '{tests}');
  assert.equal(quoteShellWord(''), '""');
  assert.equal(quoteShellWord('npm run build && npm test'), '"npm run build && npm test"');
  assert.equal(quoteShellWord('sag "hi"'), '"sag \\"hi\\""');
  assert.equal(quoteShellWord("it's"), `"it's"`);
  const words = ['sh', '-c', 'if [ -f package.json ]; then npm test; else echo "kein Code"; fi', 'a\\b', ''];
  const line = joinShellLine(words);
  assert.equal(line, 'sh -c "if [ -f package.json ]; then npm test; else echo \\"kein Code\\"; fi" "a\\\\b" ""');
  assert.deepEqual(splitShellLine(line), words);
  assert.equal(joinShellLine(['docker', 'compose', 'up', '-d', '--build']), 'docker compose up -d --build');
});
