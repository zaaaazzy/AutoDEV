import assert from 'node:assert/strict';
import { test } from 'node:test';
import { failureTail, fullTestCommand, useLatestMain } from '../runner/test-request.js';
import { parseScope } from '../api/test-requests.js';
import { requiredRole } from '../api/route-table.test.js';
import type { Pool } from 'pg';
import { categoryFromBug } from './bug-category.js';
import { caseBugs, fileBugs, stepBug } from './test-bugs.js';
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

test('Testbefunde: Kategorie aus der Testdatei (src/ → backend, frontend/ → frontend)', () => {
  const unit = caseBugs([{ ...base, category: 'unit', device: null, file: 'src/core/test-bugs.test.ts' }], 'r')[0]!;
  assert.deepEqual(unit.paths, ['src/core/test-bugs.test.ts']);
  assert.equal(categoryFromBug(unit), 'backend');
  const ui = caseBugs([{ ...base, file: 'frontend/src/app/features/bugs/bugs.check.ts' }], 'r')[0]!;
  assert.equal(categoryFromBug(ui), 'frontend');
  // Ohne Pfad (nur Dateiname) entscheidet nicht die Regel, sondern später das Modell.
  assert.equal(categoryFromBug(caseBugs([base], 'r')[0]!), null);
});

test('Testbefunde: fileBugs schreibt die Kategorie aus den Pfaden in den INSERT', async () => {
  const inserts: unknown[][] = [];
  const pool = {
    query: async (sql: string, values: unknown[]) => {
      assert.match(sql, /INSERT INTO bugs \(project_slug, title, description, severity, source, category\)/);
      inserts.push(values);
      return { rowCount: 1, rows: [{ id: `bug-${inserts.length}` }] };
    },
  } as unknown as Pool;
  const drafts = [
    ...caseBugs([{ ...base, category: 'unit', device: null, file: 'src/core/a.test.ts' }], 'r'),
    ...caseBugs([{ ...base, file: 'frontend/src/app/b.spec.ts' }], 'r'),
    stepBug('npm run lint', 'deploy/backup.sh: Zeile 3 fehlerhaft', 'r'),
  ];
  assert.equal(await fileBugs(pool, 'shop', drafts), 3);
  assert.deepEqual(
    inserts.map((values) => values[4]),
    ['backend', 'frontend', 'infrastructure'],
  );
});

test('Testbefunde: fehlgeschlagener Schritt ohne Einzeltests wird ein Bug mit Ausgabe-Ende', () => {
  const bug = stepBug('npm run lint', 'Zeile 1\nFehler am Ende', 'run-2');
  assert.equal(bug.title, 'Test fehlgeschlagen: npm run lint');
  assert.match(bug.description, /Fehler am Ende/);
  assert.match(bug.description, /#runs\/run-2/);
});

test('Kompletter Test: Befehl mit Projekt, Anfrage und Bugs; Umfang wird geprüft; Rolle „Agents ausführen“', () => {
  assert.deepEqual(fullTestCommand('dev-log', { id: 'a1', scope: 'full', evidenceId: null }), [
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
  assert.equal(fullTestCommand('dev-log', { id: 'a1', scope: 'ui', evidenceId: null }).at(-1), '--nur-oberflaeche');
  assert.equal(parseScope({}), 'full');
  assert.equal(parseScope({ scope: 'ui' }), 'ui');
  assert.equal(parseScope({ scope: 'alles' }), null);
  assert.equal(requiredRole('POST', '/api/projects/dev-log/test-requests', {}), 'run');
});

test('Kompletter Test: im Agenten-Worktree bei sauberem Stand main auschecken, offene Änderungen ablehnen', async () => {
  const calls: string[] = [];
  const execute =
    (status: string, dirs = '/repo/.git/worktrees/agent\n/repo/.git\n') =>
    async (command: string[]) => {
      calls.push(command.join(' '));
      const output = command.includes('--git-common-dir')
        ? dirs
        : command.includes('symbolic-ref')
          ? 'sprint/sprint-7\n'
          : command.includes('--porcelain')
            ? status
            : '';
      return { exitCode: 0, output, durationMs: 0 };
    };
  // Verknüpfter Worktree (unabhängig vom Ordnernamen): main losgelöst auschecken, vorherigen Branch zurückgeben.
  assert.equal(await useLatestMain('/x/agent', execute('')), 'sprint/sprint-7');
  assert.ok(calls.includes('git checkout -q --detach main'));
  calls.length = 0;
  await assert.rejects(useLatestMain('/x/agent', execute(' M datei.ts')), /Offene Änderungen im Agent-Worktree/);
  assert.ok(!calls.some((call) => call.startsWith('git checkout')));
  calls.length = 0;
  // Hauptordner (eigenes = gemeinsames Git-Verzeichnis): nichts tun.
  assert.equal(await useLatestMain('/x/Mainty', execute('', '/x/Mainty/.git\n/x/Mainty/.git\n')), null);
  assert.ok(!calls.some((call) => call.startsWith('git checkout') || call.startsWith('git status')));
});

test('Kompletter Test: früh gescheiterter Befehl liefert die Fehlerzeile', () => {
  assert.equal(
    failureTail('> test:full\n\nError: http://127.0.0.1:3196/health is already used\n\nBericht: …'),
    'Error: http://127.0.0.1:3196/health is already used',
  );
  assert.equal(failureTail('a\nb\nc\nd'), 'b · c · d');
  assert.equal(failureTail(''), 'Testbefehl fehlgeschlagen.');
});
