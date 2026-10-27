import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool } from 'pg';
import { backfillFailures, failureDetail, isAgentFailure, isEnvironmentFailure, queueBugFix } from './autofix.js';
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
  assert.equal(changesWorkingTree({ phase: 'after_task', role: 'documenter' }), true);
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

test('Bugfix-Auftrag erbt keinen abgeschlossenen oder abgebrochenen Sprint (sonst hängt er am Sprintlimit)', async () => {
  const queries: { sql: string; values: unknown[] }[] = [];
  const pool = {
    query: async (sql: string, values: unknown[] = []) => {
      queries.push({ sql, values });
      return { rows: [], rowCount: 1 };
    },
  } as unknown as Pool;
  await queueBugFix(pool, { title: 'Doku', sprintId: 'sprint-alt' }, 'bug-1');
  const insert = queries.find((query) => query.sql.includes('INSERT INTO development_items'));
  assert.equal(insert?.values[1], 'sprint-alt');
  // Offener Sprint bleibt, geschlossener wird durch den aktiven ersetzt; ohne Sprint bleibt es ohne.
  assert.match(
    insert?.sql ?? '',
    /CASE WHEN \$2::uuid IS NOT NULL THEN COALESCE\(\s*\(SELECT s\.id FROM sprints s WHERE s\.id = \$2::uuid AND s\.status NOT IN \('completed', 'cancelled'\)\),\s*\(SELECT s\.id FROM sprints s WHERE s\.project_slug = b\.project_slug AND s\.status = 'active'/,
  );
});

test('ENOENT in einem Test ist kein Umgebungsfehler (Auftrag ea3a49b1)', () => {
  const out = "not ok 3 - liest Fixture\n  Error: ENOENT: no such file or directory, scandir '/tmp/fixtures/missing'";
  assert.equal(isEnvironmentFailure(out), false);
  assert.equal(isEnvironmentFailure('Path "/x/fixtures" does not exist'), false);
});

test('EROFS, EACCES und EPERM (z. B. read_only-Container) sind Code-Fehler, kein endloser Neustart als Umgebung', () => {
  for (const out of [
    "Error: EROFS: read-only file system, open '/app/uploads/a.png'",
    "Error: EACCES: permission denied, mkdir '/home/node/.npm/_cacache'",
    "Error: EPERM: operation not permitted, chown '/work/node_modules'",
  ]) {
    assert.equal(isEnvironmentFailure(out), false, out);
    assert.equal(isAgentFailure(out), false, out);
  }
});

test('Nutzungslimit des Agent-Kontos: Agent-Fehler ohne Bug, Neustart erst nach dem Reset', async () => {
  const { usageLimitReset } = await import('./autofix.js');
  const output = "Agent „Entwickler“ scheiterte:\n\nYou've hit your session limit · resets 12:40am (Europe/Zurich)";
  assert.equal(isAgentFailure(output), true);
  const now = new Date('2026-10-20T23:16:00+02:00');
  const reset = usageLimitReset(output, now);
  assert.ok(reset, 'Reset-Zeit erkannt');
  // 00:40 Uhr des Folgetags plus drei Minuten Reserve.
  assert.equal(reset.getHours(), 0);
  assert.equal(reset.getMinutes(), 43);
  assert.ok(reset.getTime() > now.getTime());
  // Wochenlimit mit Datum, Nachmittagszeit.
  const weekly = usageLimitReset("You've hit your weekly limit · resets Oct 24 at 3pm (Europe/Zurich)", now);
  assert.equal(weekly?.getMonth(), 9);
  assert.equal(weekly?.getDate(), 24);
  assert.equal(weekly?.getHours(), 15);
  // Ohne lesbare Zeit: eine Stunde später. Ohne Limit-Meldung: nichts.
  const vague = usageLimitReset("You've hit your usage limit.", now);
  assert.equal(vague?.getTime(), now.getTime() + 60 * 60_000);
  assert.equal(usageLimitReset('AssertionError: expected 2 to equal 3', now), null);
});

test('ENOENT gilt nur für den fehlenden Agent-Befehl als Agent-Fehler, nicht für ein fehlendes Fixture im Test', () => {
  assert.equal(isAgentFailure('spawn claude ENOENT'), true);
  assert.equal(isAgentFailure("Error: ENOENT: no such file or directory, open 'test/fixtures/a.json'"), false);
});

test('failureDetail: abgelehnte Abnahme oder nur grüne Tests ergeben keine irreführende Testzusammenfassung', () => {
  const green = 'TAP version 13\nok 1 - a\n1..1\n# tests 1\n# pass 1\n# fail 0\n';
  assert.equal(failureDetail(green), null);
  const rejected = `${green}\n## Abnahme nicht bestanden\n- DoD 1 „Kriterium“: Abdeckung nicht messbar`;
  assert.equal(failureDetail(rejected), null);
});
