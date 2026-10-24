import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';
import {
  blockForBudget,
  type BudgetState,
  budgetStates,
  budgetTodo,
  checkBudget,
  exceededState,
  holdForBudget,
  loadBudgets,
  loadRoleLimits,
  releaseBudgetBlocks,
  spendByRole,
  usagePercent,
  warnThresholds,
} from './budget.js';
import { budgetGate, type RunContext } from './runner-context.js';
import { localDay, localTimeZone } from '../core/time-zone.js';

interface Query {
  sql: string;
  values: unknown[];
}

/** Antwortet je nach SQL; unbekannte Abfragen liefern nichts. */
function fakePool(answer: (sql: string, values: unknown[]) => { rows: unknown[]; rowCount?: number } | undefined) {
  const queries: Query[] = [];
  const pool = {
    query: async (sql: string, values: unknown[] = []) => {
      queries.push({ sql, values });
      return answer(sql, values) ?? { rows: [], rowCount: 0 };
    },
  } as unknown as Pool;
  return { pool, queries };
}

const state = (overrides: Partial<BudgetState> = {}): BudgetState => ({
  period: 'day',
  key: '2026-10-20',
  limit: { period: 'day', maxTokens: 1000, maxCostUsd: null },
  spend: { tokens: 0, costUsd: 0 },
  percent: 0,
  ...overrides,
});

test('Anteil am Limit: der höhere von Tokens und Kosten; leere Grenze zählt nicht', () => {
  assert.equal(usagePercent({ tokens: 800, costUsd: 1 }, { period: 'day', maxTokens: 1000, maxCostUsd: 10 }), 80);
  assert.equal(usagePercent({ tokens: 100, costUsd: 5 }, { period: 'day', maxTokens: 1000, maxCostUsd: 4 }), 125);
  // Ollama: 0 USD, die Tokens zählen trotzdem gegen das Token-Limit.
  assert.equal(usagePercent({ tokens: 1000, costUsd: 0 }, { period: 'day', maxTokens: 1000, maxCostUsd: 1 }), 100);
  assert.equal(usagePercent({ tokens: 10_000, costUsd: 0 }, { period: 'day', maxTokens: null, maxCostUsd: 1 }), 0);
});

test('ohne Limits keine Prüfung des Verbrauchs (Verhalten wie bisher)', async () => {
  const { pool, queries } = fakePool((sql) =>
    sql.includes('FROM budgets') ? { rows: [{ period: 'day', maxTokens: null, maxCostUsd: null }] } : undefined,
  );
  assert.deepEqual(await loadBudgets(pool, 'mainty'), []);
  const check = await checkBudget(pool, 'mainty', { itemId: 'item-1' });
  assert.deepEqual(check, { states: [], exceeded: null, percent: 0 });
  assert.ok(!queries.some((query) => query.sql.includes('agent_run_steps')));
});

test('Tageslimit: Verbrauch aus Agent-Schritten und Systemagents, erreicht bei 100 %', async () => {
  const { pool, queries } = fakePool((sql) => {
    if (sql.includes('FROM budgets')) return { rows: [{ period: 'day', maxTokens: '1000', maxCostUsd: null }] };
    if (sql.includes('UNION ALL')) return { rows: [{ tokens: '1200', cost: '0' }] };
    return undefined;
  });
  const check = await checkBudget(pool, 'mainty');
  assert.equal(check.exceeded?.period, 'day');
  assert.equal(check.percent, 120);
  const spendQuery = queries.find((query) => query.sql.includes('UNION ALL'));
  assert.match(spendQuery?.sql ?? '', /agent_run_steps[\s\S]*agent_usage/);
  // Budget-Tag in Ortszeit, berechnet im Worker (nicht CURRENT_DATE der UTC-Datenbank).
  assert.deepEqual(spendQuery?.values, ['mainty', localDay().since]);
  assert.equal(check.exceeded?.key, localDay().key);
  assert.ok(!queries.some((query) => query.sql.includes('CURRENT_DATE')));
  assert.match(budgetTodo(check.exceeded!), /^Budget erreicht: erhöhen oder bis morgen warten \(Tageslimit: 1k Tokens/);
});

test('Auftragslimit zählt nur die Läufe seit dem letzten manuellen Start', async () => {
  const { pool } = fakePool((sql) => {
    if (sql.includes('FROM budgets')) return { rows: [{ period: 'order', maxTokens: null, maxCostUsd: '2.00' }] };
    if (sql.includes('budget_since')) return { rows: [{ tokens: '50', cost: '1.5', since: null }] };
    return undefined;
  });
  const check = await checkBudget(pool, 'mainty', { itemId: 'item-1' });
  assert.equal(check.exceeded, null);
  assert.equal(check.percent, 75);
  assert.equal(check.states[0]?.key, 'item-1:');
  // Ohne Auftrag (Chat, Autor) gilt das Auftragslimit nicht.
  assert.deepEqual((await checkBudget(pool, 'mainty')).states, []);
});

test('Sprintlimit ohne aktiven Sprint gilt nicht', async () => {
  const { pool } = fakePool((sql) =>
    sql.includes('FROM budgets') ? { rows: [{ period: 'sprint', maxTokens: '10', maxCostUsd: null }] } : undefined,
  );
  assert.deepEqual((await checkBudget(pool, 'mainty')).states, []);
});

test('Push-Warnung ab 80 %: genau einmal je Projekt, Zeitraum und Periode', async () => {
  const warned = new Set<string>();
  const { pool } = fakePool((sql, values) => {
    if (!sql.includes('INSERT INTO budget_warnings')) return undefined;
    const key = values.join('|');
    if (warned.has(key)) return { rows: [] };
    warned.add(key);
    return { rows: [{}] };
  });
  const pushes: string[] = [];
  const send = async (_pool: Pool, message: { title: string }) => {
    pushes.push(message.title);
    return 1;
  };
  const below = state({ percent: 79.9 });
  const above = state({ percent: 85, spend: { tokens: 850, costUsd: 0 } });
  assert.deepEqual(await warnThresholds(pool, 'mainty', [below], send), []);
  assert.equal((await warnThresholds(pool, 'mainty', [above], send)).length, 1);
  assert.equal((await warnThresholds(pool, 'mainty', [{ ...above, percent: 95 }], send)).length, 0);
  // Neue Periode (Folgetag) → wieder genau eine Warnung.
  assert.equal((await warnThresholds(pool, 'mainty', [{ ...above, key: '2026-10-21' }], send)).length, 1);
  assert.deepEqual(pushes, ['💰 Budget zu 85 % verbraucht · mainty', '💰 Budget zu 85 % verbraucht · mainty']);
});

test('erreichter Zeitraum: der erste mit mindestens 100 %', () => {
  assert.equal(exceededState([state({ percent: 99.9 })]), null);
  assert.equal(exceededState([state({ percent: 50 }), state({ period: 'order', percent: 100 })])?.period, 'order');
});

test('Tageslimit am Folgetag bzw. nach Erhöhung: Auftrag wird frei, die Aktion „Budget“ verschwindet', async () => {
  let tokens = '1500';
  const { pool, queries } = fakePool((sql) => {
    if (sql.includes('budget_blocked IS NOT NULL') && sql.startsWith('SELECT'))
      return { rows: [{ id: 'item-1', sprintId: null, period: 'day' }] };
    if (sql.includes('FROM budgets')) return { rows: [{ period: 'day', maxTokens: '1000', maxCostUsd: null }] };
    if (sql.includes('CURRENT_DATE')) return { rows: [{ key: '2026-10-21', since: '2026-10-21' }] };
    if (sql.includes('UNION ALL')) return { rows: [{ tokens, cost: '0' }] };
    if (sql.includes("SET status = 'planned'")) return { rows: [], rowCount: 1 };
    if (sql.includes('SET action_todo')) return { rows: [{ sprintId: null }] };
    return undefined;
  });
  assert.deepEqual(await releaseBudgetBlocks(pool, 'mainty'), []);
  tokens = '0';
  assert.deepEqual(await releaseBudgetBlocks(pool, 'mainty'), ['item-1']);
  const todo = queries.find((query) => query.sql.includes('SET action_todo'));
  assert.deepEqual(todo?.values, ['item-1', null]);
});

test('Projektbudget erreicht: genau ein Auftrag wartet mit „Aktion notwendig“ und Push', async () => {
  let alreadyHeld = false;
  const { pool, queries } = fakePool((sql) => {
    if (sql.includes("SET status = 'blocked'")) return { rows: alreadyHeld ? [] : [{ id: 'item-1' }] };
    if (sql.includes('SET action_todo')) return { rows: [{ sprintId: null }] };
    return undefined;
  });
  const pushes: string[] = [];
  const send = async (_pool: Pool, message: { body: string }) => {
    pushes.push(message.body);
    return 1;
  };
  const item = { id: 'item-1', projectSlug: 'mainty', title: 'Doku' };
  const exceeded = state({ percent: 100, spend: { tokens: 1000, costUsd: 0 } });
  assert.equal(await holdForBudget(pool, item, exceeded, send), true);
  assert.ok(
    queries.some(
      (query) => query.sql.includes('SET action_todo') && String(query.values[1]).startsWith('Budget erreicht'),
    ),
  );
  assert.match(pushes[0] ?? '', /Budget erreicht/);
  alreadyHeld = true;
  assert.equal(await holdForBudget(pool, { ...item, id: 'item-2' }, exceeded, send), false);
  assert.equal(pushes.length, 1);
});

test('Budget-Tag in Ortszeit: kurz nach Mitternacht zählt schon der neue Tag', () => {
  // 21.10.2026 01:30 MESZ = 20.10.2026 23:30 UTC
  assert.deepEqual(localDay(new Date('2026-10-20T23:30:00Z'), 'Europe/Zurich'), {
    key: '2026-10-21',
    since: '2026-10-20T22:00:00.000Z',
  });
  // Winterzeit: 01.12.2026 00:15 MEZ = 30.11.2026 23:15 UTC
  assert.deepEqual(localDay(new Date('2026-11-30T23:15:00Z'), 'Europe/Zurich'), {
    key: '2026-12-01',
    since: '2026-11-30T23:00:00.000Z',
  });
  // Kurz vor Mitternacht Ortszeit bleibt es beim Vortag.
  assert.equal(localDay(new Date('2026-10-20T21:59:00Z'), 'Europe/Zurich').key, '2026-10-20');
  assert.equal(localDay(new Date('2026-10-20T23:30:00Z'), 'UTC').key, '2026-10-20');
});

test('Zeitzone aus DEV_LOG_TIMEZONE, Standard Europe/Zurich, Unbekanntes fällt zurück', () => {
  assert.equal(localTimeZone({}), 'Europe/Zurich');
  assert.equal(localTimeZone({ DEV_LOG_TIMEZONE: 'America/New_York' }), 'America/New_York');
  assert.equal(localTimeZone({ DEV_LOG_TIMEZONE: 'Mars/Olympus' }), 'Europe/Zurich');
});

test('Sprintlimit: Sprintbeginn ist Mitternacht Ortszeit', async () => {
  const { pool, queries } = fakePool((sql) => {
    if (sql.includes('FROM budgets')) return { rows: [{ period: 'sprint', maxTokens: '1000', maxCostUsd: null }] };
    if (sql.includes('FROM sprints')) return { rows: [{ id: 'sprint-1', since: '2026-10-19 00:00:00+02' }] };
    return undefined;
  });
  await checkBudget(pool, 'mainty');
  const sprint = queries.find((query) => query.sql.includes('FROM sprints'));
  assert.match(sprint?.sql ?? '', /start_date::timestamp AT TIME ZONE \$3/);
  assert.equal(sprint?.values[2], localTimeZone());
});

// ── Token-Limits je Agent-Rolle ──────────────────────────────────────────────────────────────────────────────────

/** Projekt ohne Projektlimit; Rollen-Limits und Verbrauch je Rolle aus den übergebenen Tabellen. */
function rolePool(roleLimits: { role: string; period: string; maxTokens: string }[], spent: Record<string, number>) {
  return fakePool((sql, values) => {
    if (sql.includes('FROM budget_role_limits')) {
      const role = values[1] as string | null;
      return { rows: roleLimits.filter((row) => role === null || row.role === role) };
    }
    if (sql.includes('GROUP BY role')) {
      const roles = values[2] as string[];
      return {
        rows: roles.filter((role) => spent[role] !== undefined).map((role) => ({ role, tokens: spent[role], cost: 0 })),
      };
    }
    return undefined;
  });
}

test('Rollen-Verbrauch: Schritte über agent_id → agents.role und agent_usage.role; ohne agent_id nur im Projekttopf', async () => {
  const { pool, queries } = rolePool([{ role: 'developer', period: 'day', maxTokens: '1000' }], { developer: 400 });
  const spend = await spendByRole(pool, 'mainty', localDay().since, ['developer']);
  assert.deepEqual(spend.get('developer'), { tokens: 400, costUsd: 0 });
  const sql = queries.find((query) => query.sql.includes('GROUP BY role'))?.sql ?? '';
  // Inner Join: Schritte ohne agent_id (eingebaute Agents, gelöschter Agent mit ON DELETE SET NULL) zählen zu keiner Rolle.
  assert.match(sql, /JOIN agents a ON a\.id = s\.agent_id[\s\S]*a\.role = ANY\(\$3\)/);
  assert.match(sql, /FROM agent_usage[\s\S]*role = ANY\(\$3\)/);
  // Der Projektverbrauch filtert nicht nach Rolle: dieselben Schritte bleiben dort enthalten (weder doppelt noch verloren).
  const project = fakePool((query) =>
    query.includes('FROM budgets') ? { rows: [{ period: 'day', maxTokens: '1000', maxCostUsd: null }] } : undefined,
  );
  await checkBudget(project.pool, 'mainty', { role: 'developer' });
  const projectSpend = project.queries.find((query) => query.sql.includes('UNION ALL'));
  assert.ok(projectSpend);
  assert.doesNotMatch(projectSpend.sql, /agents a|agent_id/);
});

test('Rollen-Limit erreicht: Schritt der Rolle developer startet nicht, tester mit freiem Limit läuft weiter', async () => {
  const { pool } = rolePool(
    [
      { role: 'developer', period: 'day', maxTokens: '500000' },
      { role: 'tester', period: 'day', maxTokens: '500000' },
    ],
    { developer: 500000, tester: 1000 },
  );
  const developer = await checkBudget(pool, 'mainty', { itemId: 'item-1', role: 'developer' });
  assert.ok(developer.exceeded);
  assert.equal(developer.exceeded.role, 'developer');
  assert.equal(developer.exceeded.key, `rolle:developer:${localDay().key}`);
  assert.match(budgetTodo(developer.exceeded),/Tageslimit der Rolle „developer“: 500k Tokens von 500k Tokens/);
  const tester = await checkBudget(pool, 'mainty', { itemId: 'item-1', role: 'tester' });
  assert.equal(tester.exceeded, null);
  assert.equal(tester.states[0]?.role, 'tester');
  // Ohne Rolle (Chat, Visionär) und für „custom“ gelten nur die Projektlimits.
  assert.deepEqual((await checkBudget(pool, 'mainty')).states, []);
  assert.deepEqual((await checkBudget(pool, 'mainty', { role: 'custom' })).states, []);
});

test('budgetGate prüft vor dem Schritt das Limit seiner Rolle', async () => {
  const { pool } = rolePool([{ role: 'developer', period: 'day', maxTokens: '100' }], { developer: 100, tester: 5 });
  const ctx = { pool, item: { id: 'item-1', projectSlug: 'mainty', sprintId: null } } as unknown as RunContext;
  assert.equal((await budgetGate(ctx, 'developer'))?.role, 'developer');
  assert.equal(await budgetGate(ctx, 'tester'), null);
});

test('Rollen-Limit entfernt (keine Zeile): keine Prüfung und keine Verbrauchsabfrage der Rolle', async () => {
  const { pool, queries } = rolePool([], { developer: 10_000_000 });
  assert.deepEqual(await checkBudget(pool, 'mainty', { role: 'developer' }), {
    states: [],
    exceeded: null,
    percent: 0,
  });
  assert.ok(!queries.some((query) => query.sql.includes('GROUP BY role')));
});

test('80-%-Warnung je Rolle und Zeitraum genau einmal (Präfix rolle:<role>: in budget_warnings)', async () => {
  const warned = new Set<string>();
  const inserts: unknown[][] = [];
  const pushes: string[] = [];
  const { pool } = fakePool((sql, values) => {
    if (sql.includes('FROM budget_role_limits'))
      return { rows: [{ role: 'developer', period: 'day', maxTokens: '1000' }] };
    if (sql.includes('GROUP BY role')) return { rows: [{ role: 'developer', tokens: 850, cost: 0 }] };
    if (!sql.includes('INSERT INTO budget_warnings')) return undefined;
    inserts.push(values);
    const key = values.join('|');
    if (warned.has(key)) return { rows: [] };
    warned.add(key);
    return { rows: [{}] };
  });
  const send = async (_pool: Pool, message: { title: string }) => {
    pushes.push(message.title);
    return 1;
  };
  const check = async () =>
    warnThresholds(pool, 'mainty', await budgetStates(pool, 'mainty', {}, await loadRoleLimits(pool, 'mainty')), send);
  assert.equal((await check()).length, 1);
  assert.equal((await check()).length, 0);
  assert.deepEqual(pushes, ['💰 Budget (developer) zu 85 % verbraucht · mainty']);
  assert.deepEqual(inserts[0], ['mainty', 'day', `rolle:developer:${localDay().key}`, 80]);
});

test('Blockade durch Rollen-Limit: Grund am Auftrag; nach Erhöhen des Limits wieder „geplant“', async () => {
  let limit = '500000';
  const { pool, queries } = fakePool((sql, values) => {
    if (sql.includes('budget_blocked IS NOT NULL') && sql.startsWith('SELECT'))
      return { rows: [{ id: 'item-1', sprintId: null, period: 'day', role: 'developer' }] };
    if (sql.includes('FROM budget_role_limits'))
      return {
        rows: [{ role: 'developer', period: 'day', maxTokens: limit }].filter(
          (row) => !values[1] || row.role === values[1],
        ),
      };
    if (sql.includes('GROUP BY role')) return { rows: [{ role: 'developer', tokens: 600000, cost: 0 }] };
    if (sql.includes("SET status = 'planned'")) return { rows: [], rowCount: 1 };
    if (sql.includes('SET action_todo')) return { rows: [{ sprintId: null }] };
    return undefined;
  });
  const exceeded = (await checkBudget(pool, 'mainty', { itemId: 'item-1', role: 'developer' })).exceeded;
  assert.ok(exceeded);
  await blockForBudget(pool, 'item-1', exceeded);
  const block = queries.find((query) => query.sql.includes('budget_blocked_role = $4'));
  assert.deepEqual(block?.values.slice(2), ['day', 'developer']);
  assert.match(String(block?.values[1]), /Tageslimit der Rolle „developer“: 600k Tokens von 500k Tokens/);
  assert.deepEqual(await releaseBudgetBlocks(pool, 'mainty'), []);
  limit = '1000000';
  assert.deepEqual(await releaseBudgetBlocks(pool, 'mainty'), ['item-1']);
});

test('Freigabe: Projektlimit-Blockade hängt nicht am Rollen-Limit einer anderen Rolle', async () => {
  const { pool } = fakePool((sql) => {
    if (sql.includes('budget_blocked IS NOT NULL') && sql.startsWith('SELECT'))
      return { rows: [{ id: 'item-1', sprintId: null, period: 'day', role: null }] };
    if (sql.includes('FROM budget_role_limits')) return { rows: [{ role: 'tester', period: 'day', maxTokens: '1' }] };
    if (sql.includes('GROUP BY role')) return { rows: [{ role: 'tester', tokens: 99, cost: 0 }] };
    if (sql.includes("SET status = 'planned'")) return { rows: [], rowCount: 1 };
    return undefined;
  });
  assert.deepEqual(await releaseBudgetBlocks(pool, 'mainty'), ['item-1']);
});
