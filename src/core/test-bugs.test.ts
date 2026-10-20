import assert from 'node:assert/strict';
import { test } from 'node:test';
import { failureTail, fullTestCommand, useLatestMain } from '../runner/test-request.js';
import { parseScope } from '../api/test-requests.js';
import { requiredRole } from '../api/roles.js';
import { caseBugs, stepBug } from './test-bugs.js';
import type { TestCaseResult } from './test-results.js';

const base: TestCaseResult = {
  category: 'user',
  title: 'Tabellen: Sortieren',
  file: 'full-ui.check.ts',
  device: 'desktop',
  status: 'failed',
  durationMs: 1200,
  errors: ['Textfilter „Titel“ hat Fokus'],
  media: [],
};

test('Testbefunde: je fehlgeschlagenem Test ein Bug mit Gerät, Befund und Link zum Lauf', () => {
  const bugs = caseBugs(
    [base, { ...base, status: 'passed', title: 'grün' }, { ...base, status: 'flaky', device: 'handy' }],
    'run-1',
  );
  assert.equal(bugs.length, 2);
  assert.equal(bugs[0]!.title, 'Oberflächentest: Tabellen: Sortieren (Desktop)');
  assert.match(bugs[0]!.description, /Textfilter „Titel“ hat Fokus/);
  assert.match(bugs[0]!.description, /#runs\/run-1/);
  assert.equal(bugs[0]!.severity, 'medium');
  assert.equal(bugs[1]!.title, 'Oberflächentest: Tabellen: Sortieren (Handy)');
  assert.equal(bugs[1]!.severity, 'low');
  assert.equal(caseBugs([{ ...base, category: 'unit', device: null }], 'r')[0]!.severity, 'high');
  assert.ok(caseBugs([{ ...base, title: 'x'.repeat(300) }], 'r')[0]!.title.length <= 180);
});

test('Testbefunde: fehlgeschlagener Schritt ohne Einzeltests wird ein Bug mit Ausgabe-Ende', () => {
  const bug = stepBug('npm run lint', 'Zeile 1\nFehler am Ende', 'run-2');
  assert.equal(bug.title, 'Test fehlgeschlagen: npm run lint');
  assert.match(bug.description, /Fehler am Ende/);
  assert.match(bug.description, /#runs\/run-2/);
});

test('Kompletter Test: Befehl mit Projekt, Anfrage und Bugs; Umfang wird geprüft; Rolle „Agents ausführen“', () => {
  assert.deepEqual(fullTestCommand('dev-log', { id: 'a1', scope: 'full' }), [
    'npm',
    'run',
    'test:full',
    '--',
    '--projekt',
    'dev-log',
    '--anfrage',
    'a1',
    '--bugs',
  ]);
  assert.equal(fullTestCommand('dev-log', { id: 'a1', scope: 'ui' }).at(-1), '--nur-oberflaeche');
  assert.equal(parseScope({}), 'full');
  assert.equal(parseScope({ scope: 'ui' }), 'ui');
  assert.equal(parseScope({ scope: 'alles' }), null);
  assert.equal(requiredRole('POST', '/api/projects/dev-log/test-requests', {}), 'run');
});

test('Kompletter Test: im Agenten-Worktree wird bei sauberem Stand main ausgecheckt, sonst nichts', async () => {
  const calls: string[] = [];
  const execute = (output: string) => async (command: string[]) => {
    calls.push(command.join(' '));
    return { exitCode: 0, output, durationMs: 0 };
  };
  await useLatestMain('/x/DevLog-agents', execute(''));
  assert.deepEqual(calls, ['git status --porcelain --untracked-files=no', 'git checkout -q --detach main']);
  calls.length = 0;
  await useLatestMain('/x/DevLog-agents', execute(' M datei.ts'));
  assert.deepEqual(calls, ['git status --porcelain --untracked-files=no']);
  calls.length = 0;
  await useLatestMain('/x/Mainty', execute(''));
  assert.deepEqual(calls, []);
});

test('Kompletter Test: früh gescheiterter Befehl liefert die Fehlerzeile', () => {
  assert.equal(
    failureTail('> test:full\n\nError: http://127.0.0.1:3196/health is already used\n\nBericht: …'),
    'Error: http://127.0.0.1:3196/health is already used',
  );
  assert.equal(failureTail('a\nb\nc\nd'), 'b · c · d');
  assert.equal(failureTail(''), 'Testbefehl fehlgeschlagen.');
});
