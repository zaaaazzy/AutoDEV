import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool } from 'pg';
import { DEFAULT_ACTIONS, MAX_PROMPT, seedDefaultActions, seedRoutineTemplates } from './agent-tasks.js';
import { parseCron } from '../core/cron.js';
import { ROUTINE_TEMPLATES } from '../setup/templates.js';

function fakePool(options: { seeded: boolean; tester: boolean }) {
  const queries: { sql: string; values: unknown[] }[] = [];
  const pool = {
    query: async (sql: string, values: unknown[] = []) => {
      queries.push({ sql, values });
      if (sql.includes('FROM app_settings')) return { rows: options.seeded ? [{}] : [] };
      if (sql.includes("role = 'tester'")) return { rows: options.tester ? [{ id: 'tester-1' }] : [] };
      if (sql.includes('INSERT INTO agent_tasks')) return { rows: [], rowCount: DEFAULT_ACTIONS.length };
      return { rows: [], rowCount: 1 };
    },
  } as unknown as Pool;
  return { pool, queries };
}

test('Standard-Aktionen: einmalig, dem Tester zugewiesen', async () => {
  const { pool, queries } = fakePool({ seeded: false, tester: true });
  assert.equal(await seedDefaultActions(pool, 'mainty'), DEFAULT_ACTIONS.length);
  const insert = queries.find((query) => query.sql.includes('INSERT INTO agent_tasks'))!;
  assert.equal(insert.values[1], 'tester-1');
  assert.ok(queries.some((query) => query.sql.includes('INSERT INTO app_settings')));
});

test('Routine-Vorlagen: die vier Vorlagen, deaktiviert, mit gültigem Zeitplan und „nur lesen“', async () => {
  const titles = ROUTINE_TEMPLATES.map((template) => template.title);
  for (const title of [
    'Nächtlicher Sicherheits-Check',
    'Wöchentlicher Doku-Abgleich',
    'Tote Dateien und TODOs finden',
    'Testabdeckung unter 75 % melden',
  ]) {
    assert.ok(titles.includes(title), title);
  }
  for (const template of ROUTINE_TEMPLATES) {
    assert.equal(typeof parseCron(template.schedule), 'object', template.schedule);
    assert.match(template.prompt, /Nur lesen/);
    assert.ok(template.prompt.length <= MAX_PROMPT);
  }
  assert.match(ROUTINE_TEMPLATES.find((t) => t.id === 'security-nightly')!.prompt, /npm audit.*npm outdated/);
  const { pool, queries } = fakePool({ seeded: false, tester: false });
  await seedRoutineTemplates(pool, 'mainty');
  const insert = queries.find((query) => query.sql.includes('INSERT INTO agent_tasks'))!;
  // Beim Anlegen immer deaktiviert, auch ohne Tester.
  assert.match(insert.sql, /v\.id, FALSE/);
  assert.deepEqual(insert.values[2], titles);
  assert.ok(queries.some((query) => query.values[0] === 'routine_templates_seeded:mainty'));
  const again = fakePool({ seeded: true, tester: false });
  assert.equal(await seedRoutineTemplates(again.pool, 'mainty'), 0);
  assert.ok(!again.queries.some((query) => query.sql.includes('INSERT INTO agent_tasks')));
});

test('Standard-Aktionen: nicht erneut und nicht ohne Tester', async () => {
  assert.equal(await seedDefaultActions(fakePool({ seeded: true, tester: true }).pool, 'mainty'), 0);
  const withoutTester = fakePool({ seeded: false, tester: false });
  assert.equal(await seedDefaultActions(withoutTester.pool, 'mainty'), 0);
  assert.ok(!withoutTester.queries.some((query) => query.sql.includes('INSERT INTO app_settings')));
});
