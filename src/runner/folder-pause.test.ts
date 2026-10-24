import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';
import { FOLDER_PAUSE_BY, pauseForFolderProblem } from './folder-pause.js';

function fakePool(sprintRow: { name: string } | null) {
  const calls: { sql: string; params: unknown[] }[] = [];
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (sql.includes('UPDATE sprints')) return { rows: sprintRow ? [sprintRow] : [], rowCount: sprintRow ? 1 : 0 };
      return { rows: [], rowCount: 1 };
    },
  } as unknown as Pool;
  return { pool, calls };
}

test('Ordnerproblem: Auftrag wartet, Sprint wird einmal pausiert (mit Kennzeichen)', async () => {
  const { pool, calls } = fakePool({ name: 'Sprint 20' });
  const paused = await pauseForFolderProblem(pool, { id: 'a', projectSlug: 'p', sprintId: 's' }, 'fremde Änderungen');
  assert.equal(paused, true);
  assert.match(calls[0]!.sql, /retry_after = NOW\(\) \+ make_interval/);
  const sprint = calls.find((call) => call.sql.includes('UPDATE sprints'))!;
  assert.match(sprint.sql, /paused_at IS NULL/);
  assert.deepEqual(sprint.params, ['s', FOLDER_PAUSE_BY]);
});

test('Ordnerproblem: schon pausierter Sprint wird nicht erneut gemeldet; ohne Sprint nur zurückstellen', async () => {
  assert.equal(
    await pauseForFolderProblem(fakePool(null).pool, { id: 'a', projectSlug: 'p', sprintId: 's' }, 'x'),
    false,
  );
  const { pool, calls } = fakePool({ name: 'egal' });
  assert.equal(await pauseForFolderProblem(pool, { id: 'a', projectSlug: 'p', sprintId: null }, 'x'), false);
  assert.equal(calls.length, 1);
});
