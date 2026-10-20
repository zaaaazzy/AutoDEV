import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';
import { isMergeConflict, MAX_CONFLICT_RETRIES, retryAfterConflict } from './review-gate.js';

test('Merge-Konflikt: Auftrag wird höchstens zweimal automatisch neu eingeplant', async () => {
  const queries: { sql: string; values: unknown[] }[] = [];
  let retries = 0;
  const pool = {
    query: async (sql: string, values: unknown[] = []) => {
      queries.push({ sql, values });
      if (sql.includes('conflict_retries < $2')) {
        if (retries >= (values[1] as number)) return { rows: [], rowCount: 0 };
        retries += 1;
        return { rows: [{ id: values[0] }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Pool;
  const item = { id: 'a', projectSlug: 'dev-log', title: 'Visuelle Abnahme' };
  const message = 'Merge-Konflikt mit sprint/sprint-5 – Branch auftrag/a bleibt bestehen.';
  assert.equal(isMergeConflict(message), true);
  assert.equal(isMergeConflict('Push abgelehnt'), false);
  assert.equal(await retryAfterConflict(pool, item, message), true);
  assert.equal(await retryAfterConflict(pool, item, message), true);
  assert.equal(await retryAfterConflict(pool, item, message), false, 'danach Aktion notwendig wie bisher');
  assert.equal(MAX_CONFLICT_RETRIES, 2);
  const update = queries.find((query) => query.sql.includes('conflict_retries < $2'))!;
  assert.match(update.sql, /status = 'planned', auto_run = TRUE/);
  assert.match(String(update.values[2]), /Entwickler löst die Konflikte/);
});
