import assert from 'node:assert/strict';
import test from 'node:test';
import { buildUpdate } from '../core/validation.js';
import { developmentUpdateExtras } from './development.js';

const AGENT = '11111111-1111-4111-8111-111111111111';
const SPRINT = '22222222-2222-4222-8222-222222222222';

/** Spalten links vom „=“ der SET-Liste (ohne die Teile in CASE-Ausdrücken). */
function setColumns(sql: string): string[] {
  const set = /SET (.*) WHERE id = \$1/s.exec(sql)?.[1] ?? '';
  let depth = 0;
  const parts: string[] = [];
  let current = '';
  for (const word of set.split(/(\s+|,)/)) {
    if (/^CASE$/i.test(word)) depth += 1;
    if (/^END$/i.test(word)) depth -= 1;
    if (word === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
    } else current += word;
  }
  parts.push(current.trim());
  return parts.map((part) => part.split('=')[0].trim());
}

test('buildUpdate: Zusatz-Zuweisungen stehen vor updated_at, Platzhalter bleiben passend', () => {
  const update = buildUpdate(
    'development_items',
    'id-1',
    [{ column: 'title', value: 'x' }],
    'id',
    { column: 'status', values: ['planned'] },
    ['auto_run = FALSE'],
  );
  assert.equal(
    update.sql,
    'UPDATE development_items SET title = $2, auto_run = FALSE, updated_at = NOW() WHERE id = $1 AND status = ANY($3) RETURNING id',
  );
  assert.deepEqual(update.values, ['id-1', 'x', ['planned']]);
});

test('Auftrag ändern: Sprint zuweisen plant ein, löscht den Entfernt-Vermerk und stoppt auto_run im geplanten Sprint', () => {
  const extras = developmentUpdateExtras([{ column: 'sprint_id', value: SPRINT }], 'planned');
  assert.deepEqual(extras, [
    "status = CASE WHEN status IN ('backlog', 'planned') THEN 'planned' ELSE status END",
    'removed_from_sprint = NULL',
    'removed_from_sprint_at = NULL',
    'auto_run = FALSE',
  ]);
  // Im aktiven Sprint bleibt auto_run unberührt.
  assert.ok(!developmentUpdateExtras([{ column: 'sprint_id', value: SPRINT }], 'active').includes('auto_run = FALSE'));
});

test('Auftrag ändern: Sprint entfernen führt nur ohne Agent zurück in den Backlog', () => {
  assert.deepEqual(developmentUpdateExtras([{ column: 'sprint_id', value: null }]), [
    "status = CASE WHEN status IN ('backlog', 'planned') THEN CASE WHEN agent_id IS NULL THEN 'backlog' ELSE 'planned' END ELSE status END",
  ]);
  assert.deepEqual(developmentUpdateExtras([{ column: 'agent_id', value: null }]), [
    "status = CASE WHEN status IN ('backlog', 'planned') THEN CASE WHEN sprint_id IS NULL THEN 'backlog' ELSE 'planned' END ELSE status END",
  ]);
});

test('Auftrag ändern: Agent von Hand starten merkt sich den Status und plant ein', () => {
  const extras = developmentUpdateExtras([{ column: 'agent_id', value: AGENT }]);
  assert.equal(extras.length, 2);
  assert.match(extras[0], /^return_status = CASE WHEN status IN \('backlog', 'blocked', 'done'\)/);
  assert.match(extras[1], /^status = CASE WHEN status IN \('backlog', 'blocked', 'done'\) THEN 'planned'/);
  // Mit ausdrücklichem Status: weder Handstart noch automatische Statuslogik.
  assert.deepEqual(
    developmentUpdateExtras([
      { column: 'status', value: 'planned' },
      { column: 'agent_id', value: AGENT },
    ]),
    [],
  );
});

test('Auftrag ändern: jede Spalte höchstens einmal in der SET-Liste, auch mit Schätzung', () => {
  const cases: { column: string; value: unknown }[][] = [
    [{ column: 'agent_id', value: AGENT }],
    [{ column: 'agent_id', value: null }],
    [
      { column: 'sprint_id', value: SPRINT },
      { column: 'agent_id', value: AGENT },
      { column: 'effort_hours', value: 2 },
    ],
    [
      { column: 'status', value: 'planned' },
      { column: 'sprint_id', value: SPRINT },
      { column: 'token_estimate', value: 1000 },
    ],
  ];
  for (const fields of cases) {
    for (const target of [undefined, 'planned', 'active']) {
      const extras = developmentUpdateExtras(fields, target);
      const update = buildUpdate('development_items', 'id-1', fields, 'id', undefined, extras);
      const columns = setColumns(update.sql);
      assert.equal(new Set(columns).size, columns.length, `doppelte Spalte in ${update.sql}`);
      assert.equal(columns.at(-1), 'updated_at');
      // Keine Zusatz-Zuweisung verweist auf einen Platzhalter ohne Wert.
      for (const match of update.sql.matchAll(/\$(\d+)/g)) {
        assert.ok(Number(match[1]) <= update.values.length, `$${match[1]} ohne Wert in ${update.sql}`);
      }
    }
  }
});
