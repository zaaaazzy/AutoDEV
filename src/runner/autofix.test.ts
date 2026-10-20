import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool } from 'pg';
import { backfillFailures, failureDetail, isAgentFailure, isEnvironmentFailure } from './autofix.js';
import { changesWorkingTree } from './runner.js';

test('agent failures without code cause are recognised', () => {
  assert.equal(isAgentFailure('… gelesen\nZeitlimit erreicht'), true);
  assert.equal(isAgentFailure('Abbruch: Das Modell wiederholt sich („x…“). Schleife erkannt.'), true);
  assert.equal(isAgentFailure('Text\n\nDer Entwickler-Agent hat keine Dateien geändert.'), true);
  assert.equal(isAgentFailure('\nspawn claude ENOENT\n'), true);
  assert.equal(isAgentFailure('$ npm test → failed\nAssertionError: expected 2 to equal 3'), false);
});

test('developer and tester hold the working-tree lock, documentation agents do not', () => {
  assert.equal(changesWorkingTree({ phase: 'while_task', role: 'custom' }), true);
  assert.equal(changesWorkingTree({ phase: 'after_task', role: 'tester' }), true);
  assert.equal(changesWorkingTree({ phase: 'after_task', role: 'documenter' }), false);
  assert.equal(changesWorkingTree({ phase: 'pre_task', role: 'bug_reviewer' }), false);
});

test('Testausgaben erscheinen als Zusammenfassung mit Codeblock, andere Ausgaben unverändert', () => {
  const tap = [
    'TAP version 13',
    '# Subtest: a',
    'not ok 1 - a',
    '  ---',
    "  error: 'kaputt'",
    '  ...',
    '# tests 1',
  ].join('\n');
  const detail = failureDetail(tap) ?? '';
  assert.match(detail, /^\*\*Testergebnis:\*\* 1 Tests · 0 bestanden · 1 fehlgeschlagen/);
  assert.match(detail, /\*\*Ausgabe \(Ende\):\*\*\n\n```text\n[\s\S]*# tests 1\n```$/);
  assert.equal(failureDetail('Der Agent hat aufgegeben.'), null);
});

test('Fehler-Nachtrag: ein vom Benutzer abgebrochener Lauf erzeugt keinen Bug-Bericht', async () => {
  // Zwei blockierte Aufträge ohne failure: einer scheiterte, der andere wurde mit „Abbrechen“ beendet.
  const blocked = [
    { id: 'kaputt', cancelled: false, output: 'AssertionError: expected 2 to equal 3' },
    { id: 'abgebrochen', cancelled: true, output: 'Vom Benutzer abgebrochen.' },
  ];
  const queries: { sql: string; values: unknown[] }[] = [];
  const pool = {
    query: async (sql: string, values: unknown[] = []) => {
      queries.push({ sql, values });
      if (sql.includes('LEFT JOIN LATERAL')) {
        // Die Datenbank wertet den Ausschluss aus; hier nur, wenn die Abfrage abgebrochene Läufe ausschliesst.
        const excludes =
          /NOT EXISTS \(SELECT 1 FROM agent_run_steps c WHERE c\.run_id = last\.run_id AND c\.cancel_requested\)/.test(
            sql,
          );
        return {
          rows: blocked
            .filter((item) => !(excludes && item.cancelled))
            .map((item) => ({
              id: item.id,
              projectSlug: 'mainty',
              title: item.id,
              kind: 'feature',
              agentName: 'Tester',
              output: item.output,
            })),
        };
      }
      if (sql.includes('INSERT INTO bugs')) return { rows: [{ id: 'bug-1' }] };
      return { rows: [], rowCount: 1 };
    },
  } as unknown as Pool;
  await backfillFailures(pool, 'mainty');
  const failed = queries
    .filter((query) => query.sql.includes('UPDATE development_items SET failure'))
    .map((query) => query.values[0]);
  assert.ok(failed.includes('kaputt'), 'echter Fehler bekommt den Bericht');
  assert.ok(!failed.includes('abgebrochen'), 'Abbruch bekommt keinen Bericht');
});

test('ENOENT in einem Test ist kein Umgebungsfehler (Auftrag ea3a49b1)', () => {
  const out = "not ok 3 - liest Fixture\n  Error: ENOENT: no such file or directory, scandir '/tmp/fixtures/missing'";
  assert.equal(isEnvironmentFailure(out), false);
  assert.equal(isEnvironmentFailure('Path "/x/fixtures" does not exist'), false);
});
