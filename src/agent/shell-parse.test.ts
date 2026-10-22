import assert from 'node:assert/strict';
import test from 'node:test';
import { parseShell, renderWords } from './shell-parse.js';

function words(command: string): string[][] {
  const parsed = parseShell(command);
  assert.ok(parsed.ok, `sollte zerlegbar sein: ${command}`);
  return parsed.commands.map((c) => c.words.map((w) => w.text));
}

function problem(command: string): string {
  const parsed = parseShell(command);
  assert.ok(!parsed.ok, `sollte abgelehnt werden: ${command}`);
  return parsed.problem;
}

test('Tokenizer: escapte Quotes sind Teil des Wortes und werden markiert', () => {
  // Nur als Eingabe des Parsers, nie ausgeführt.
  const parsed = parseShell("git log \\' $(id) \\'");
  assert.equal(parsed.ok, false, '$(id) bleibt als Ersetzung sichtbar und wird gesperrt');
  const escaped = parseShell('git log \\" > /tmp/x \\"');
  assert.ok(escaped.ok);
  assert.equal(escaped.escapedQuote, true);
  assert.equal(escaped.commands[0]?.redirects.length, 1);
});

test('Tokenizer: Quotes, Backslash und Fortsetzungszeilen', () => {
  assert.deepEqual(words('echo \'a;b\' "c && d"'), [['echo', 'a;b', 'c && d']]);
  assert.deepEqual(words("echo 'C:\\'"), [['echo', 'C:\\']]);
  assert.deepEqual(words('echo a\\ b'), [['echo', 'a b']]);
  assert.deepEqual(words('echo a\\\nb'), [['echo', 'ab']]);
  assert.deepEqual(words("echo $'a\\tb\\'c'"), [['echo', "a\tb'c"]]);
});

test('Tokenizer: Ketten, Kommentare und Umleitungen', () => {
  assert.deepEqual(words('a; b && c || d | e\nf # Kommentar'), [['a'], ['b'], ['c'], ['d'], ['e'], ['f']]);
  const parsed = parseShell('cat x 2>/dev/null >> out');
  assert.ok(parsed.ok);
  assert.deepEqual(
    parsed.commands[0]?.redirects.map((r) => [r.operator, r.target.text]),
    [
      ['2>', '/dev/null'],
      ['>>', 'out'],
    ],
  );
});

test('Tokenizer: Markierungen für Erweiterungen und Globs', () => {
  const parsed = parseShell('ls $HOME *.ts "*.md" ~');
  assert.ok(parsed.ok);
  const w = parsed.commands[0]?.words ?? [];
  assert.equal(w[1]?.expanded, true);
  assert.equal(w[2]?.glob, true);
  assert.equal(w[3]?.glob, false);
  assert.equal(w[4]?.expanded, true);
});

test('Tokenizer: nicht Prüfbares wird abgelehnt (fail-closed)', () => {
  for (const command of [
    'echo $(id)',
    'echo `id`',
    'echo "$(id)"',
    '(ls)',
    'sleep 1 &',
    'cat <<EOF',
    'echo ${HOME}',
    "echo 'offen",
    'echo "offen',
    'echo ende\\',
    "echo $'offen",
    'echo >',
    'ls ;; ls',
    'if true; then ls; fi',
    'cat <(ls)',
  ]) {
    assert.ok(problem(command).length > 0, command);
  }
});

test('renderWords: Sonderzeichen werden in Einzelquotes gesetzt', () => {
  const parsed = parseShell("echo 'a b' it\\'s *.ts");
  assert.ok(parsed.ok);
  assert.equal(renderWords(parsed.commands[0]?.words ?? []), "echo 'a b' 'it'\\''s' '*.ts'");
});
