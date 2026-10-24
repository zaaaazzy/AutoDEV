import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';
import {
  collectBudget,
  loadDisplay,
  parseBudgetInput,
  parseRoleLimitsInput,
  registerBudgetRoutes,
  saveBudget,
} from './budget.js';
import type { Principal } from './roles.js';
import { guardStatus, requiredRole } from './route-table.test.js';

test('Budget-Eingaben: leer = unbegrenzt, ungültige Werte werden abgelehnt', () => {
  assert.deepEqual(
    parseBudgetInput({
      limits: { day: { maxTokens: '200000', maxCostUsd: '' }, order: { maxTokens: null, maxCostUsd: 2.5 } },
      currency: 'CHF',
      chfPerUsd: '0.9',
      rules: null,
      localModel: ' qwen3.5:9b ',
      strongCommand: ['claude', '-p'],
    }),
    {
      limits: { day: { maxTokens: 200000, maxCostUsd: null }, order: { maxTokens: null, maxCostUsd: 2.5 } },
      display: { currency: 'CHF', chfPerUsd: 0.9 },
      rules: null,
      localModel: 'qwen3.5:9b',
      strongCommand: ['claude', '-p'],
    },
  );
  assert.match(String(parseBudgetInput({ limits: { day: { maxTokens: -5 } } })), /positive Zahl/);
  assert.match(String(parseBudgetInput({ currency: 'EUR', chfPerUsd: 1 })), /USD oder CHF/);
  assert.match(String(parseBudgetInput({ currency: 'CHF', chfPerUsd: 0 })), /Wechselkurs/);
  assert.match(String(parseBudgetInput({ rules: [{ tier: 'x' }] })), /Stufe/);
  assert.match(String(parseBudgetInput({ strongCommand: 'claude -p' })), /CLI-Befehl/);
  assert.deepEqual(parseBudgetInput({ strongCommand: [] }), { strongCommand: null });
});

test('Speichern: leere Limits entfernen den Zeitraum, Regeln in Reihenfolge, Standardregeln mit null', async () => {
  const queries: { sql: string; values: unknown[] }[] = [];
  const pool = {
    query: async (sql: string, values: unknown[] = []) => {
      queries.push({ sql, values });
      return { rows: [] };
    },
  } as unknown as Pool;
  await saveBudget(pool, 'mainty', {
    limits: { day: { maxTokens: 1000, maxCostUsd: null }, sprint: { maxTokens: null, maxCostUsd: null } },
    rules: [
      { condition: { categories: ['docs'] }, tier: 'local' },
      { condition: { minRetries: 1 }, tier: 'up' },
    ],
  });
  assert.ok(queries.some((query) => query.sql.includes('INSERT INTO budgets') && query.values[1] === 'day'));
  assert.ok(queries.some((query) => query.sql.includes('DELETE FROM budgets') && query.values[1] === 'sprint'));
  const inserted = queries.filter((query) => query.sql.includes('INSERT INTO routing_rules'));
  assert.deepEqual(
    inserted.map((query) => [query.values[1], query.values[3]]),
    [
      [0, 'local'],
      [1, 'up'],
    ],
  );
  assert.ok(queries.some((query) => query.sql.includes('routing_customized') && query.values[1] === true));
  queries.length = 0;
  await saveBudget(pool, 'mainty', { rules: null });
  assert.ok(queries.some((query) => query.sql.includes('routing_customized') && query.values[1] === false));
  assert.ok(!queries.some((query) => query.sql.includes('INSERT INTO routing_rules')));
});

test('gespeicherte Limits erscheinen beim erneuten Öffnen unverändert; Währung mit festem Kurs', async () => {
  const pool = {
    query: async (sql: string) => {
      if (sql.includes('FROM budgets')) return { rows: [{ period: 'order', maxTokens: '500000', maxCostUsd: '3.50' }] };
      if (sql.includes('budget_currency') || sql.includes('ANY($1)'))
        return {
          rows: [
            { key: 'budget_currency', value: 'CHF' },
            { key: 'budget_chf_per_usd', value: '0.85' },
          ],
        };
      if (sql.includes('FROM projects')) return { rows: [{ customized: false, local: null, strong: null }] };
      if (sql.includes('ollama_models')) return { rows: [{ value: '["qwen3.5:9b"]' }] };
      return { rows: [] };
    },
  } as unknown as Pool;
  assert.deepEqual(await loadDisplay(pool), { currency: 'CHF', chfPerUsd: 0.85 });
  const overview = await collectBudget(pool, 'mainty');
  assert.deepEqual(overview.limits, {
    day: { maxTokens: null, maxCostUsd: null },
    sprint: { maxTokens: null, maxCostUsd: null },
    order: { maxTokens: 500000, maxCostUsd: 3.5 },
  });
  assert.deepEqual(overview.ollamaModels, ['qwen3.5:9b']);
  assert.equal((overview.routing as { customized: boolean }).customized, false);
});

test('Budget ändern ist Administration, Lesen für alle Projektmitglieder', () => {
  assert.equal(requiredRole('PUT', '/api/projects/mainty/budget', {}), 'admin');
});

// ── Token-Limits je Agent-Rolle ──────────────────────────────────────────────────────────────────────────────────

interface Captured {
  sql: string;
  values: unknown[];
}

/** Pool mit Transaktions-Client; protokolliert alle Abfragen. */
function rolePool(answer: (sql: string, values: unknown[]) => { rows: unknown[] } | undefined = () => undefined) {
  const queries: Captured[] = [];
  const query = async (sql: string, values: unknown[] = []) => {
    queries.push({ sql, values });
    return answer(sql, values) ?? { rows: [], rowCount: 0 };
  };
  const pool = { query, connect: async () => ({ query, release: () => undefined }) } as unknown as Pool;
  return { pool, queries };
}

/** Ruft den Handler einer Budget-Route direkt auf (ohne Rechteprüfung, die testet guardStatus). */
async function callRoute(
  pool: Pool,
  method: 'get' | 'put',
  path: string,
  params: Record<string, string>,
  body?: unknown,
) {
  const handlers = new Map<string, (request: unknown, response: unknown) => Promise<void>>();
  const app = {
    get: (route: string, ...chain: unknown[]) => handlers.set(`get ${route}`, chain.at(-1) as never),
    put: (route: string, ...chain: unknown[]) => handlers.set(`put ${route}`, chain.at(-1) as never),
  };
  registerBudgetRoutes(app as never, pool);
  const result = { status: 200, body: undefined as unknown };
  const response = {
    status(code: number) {
      result.status = code;
      return this;
    },
    json(payload: unknown) {
      result.body = payload;
      return this;
    },
  };
  await handlers.get(`${method} ${path}`)?.({ params, body }, response);
  return result;
}

const writes = (queries: Captured[]) =>
  queries.filter((query) => /INSERT INTO budget_role_limits|DELETE FROM budget_role_limits/.test(query.sql));

test('Rollen-Limits: Eingaben prüfen; null bzw. maxTokens null entfernt die Grenze', () => {
  assert.deepEqual(parseRoleLimitsInput({ day: { maxTokens: 500000 } }), { day: 500000 });
  assert.deepEqual(parseRoleLimitsInput({ day: { maxTokens: null }, sprint: null, order: { maxTokens: '2000' } }), {
    day: null,
    sprint: null,
    order: 2000,
  });
  assert.match(String(parseRoleLimitsInput({ day: { maxTokens: -5 } })), /positive Zahl/);
  assert.match(String(parseRoleLimitsInput({ day: { maxTokens: 'abc' } })), /positive Zahl/);
  assert.match(String(parseRoleLimitsInput({ day: { maxTokens: 0 } })), /positive Zahl/);
  assert.match(String(parseRoleLimitsInput({ day: 5 })), /maxTokens/);
  assert.match(String(parseRoleLimitsInput({ week: { maxTokens: 5 } })), /Unbekannter Zeitraum „week“/);
  assert.match(String(parseRoleLimitsInput({})), /Mindestens einen Zeitraum/);
  assert.match(String(parseRoleLimitsInput('x')), /Ungültige Anfrage/);
});

test('PUT /budget/roles/developer speichert das Tageslimit in einer Transaktion und gibt Blockaden frei', async () => {
  const { pool, queries } = rolePool((sql) => (sql.includes('FROM projects') ? { rows: [{}] } : undefined));
  const result = await callRoute(
    pool,
    'put',
    '/projects/:slug/budget/roles/:role',
    { slug: 'mainty', role: 'developer' },
    { day: { maxTokens: 500000 } },
  );
  assert.equal(result.status, 200);
  const [insert] = writes(queries);
  assert.match(insert?.sql ?? '', /INSERT INTO budget_role_limits/);
  assert.deepEqual(insert?.values, ['mainty', 'developer', 'day', 500000]);
  const order = queries.map((query) => query.sql);
  const at = order.indexOf(insert?.sql ?? '');
  assert.ok(order.indexOf('BEGIN') < at && at < order.indexOf('COMMIT'));
  assert.ok(queries.some((query) => query.sql.includes('budget_blocked IS NOT NULL')));
});

test('PUT mit maxTokens null löscht die Zeile der Rolle', async () => {
  const { pool, queries } = rolePool((sql) => (sql.includes('FROM projects') ? { rows: [{}] } : undefined));
  await callRoute(
    pool,
    'put',
    '/projects/:slug/budget/roles/:role',
    { slug: 'mainty', role: 'developer' },
    { day: { maxTokens: null } },
  );
  const [remove] = writes(queries);
  assert.match(remove?.sql ?? '', /DELETE FROM budget_role_limits/);
  assert.deepEqual(remove?.values, ['mainty', 'developer', 'day']);
});

test('PUT mit unbekannter Rolle oder ungültiger Grenze: 400 mit deutscher Meldung, nichts gespeichert', async () => {
  for (const role of ['custom', 'foo', 'admin']) {
    const { pool, queries } = rolePool(() => ({ rows: [{}] }));
    const result = await callRoute(
      pool,
      'put',
      '/projects/:slug/budget/roles/:role',
      { slug: 'mainty', role },
      { day: { maxTokens: 1000 } },
    );
    assert.equal(result.status, 400, role);
    assert.match(String((result.body as { message: string }).message), /Unbekannte Agent-Rolle/);
    assert.deepEqual(writes(queries), []);
  }
  for (const maxTokens of [-5, 'abc']) {
    const { pool, queries } = rolePool(() => ({ rows: [{}] }));
    const result = await callRoute(
      pool,
      'put',
      '/projects/:slug/budget/roles/:role',
      { slug: 'mainty', role: 'developer' },
      { day: { maxTokens } },
    );
    assert.equal(result.status, 400);
    assert.deepEqual(writes(queries), []);
  }
});

test('GET /budget/roles: gesetztes Limit mit maxTokens und aktuellem Verbrauch der Rolle', async () => {
  const { pool } = rolePool((sql) => {
    if (sql.includes('FROM budget_role_limits'))
      return { rows: [{ role: 'developer', period: 'day', maxTokens: '500000' }] };
    if (sql.includes('GROUP BY role')) return { rows: [{ role: 'developer', tokens: '125000', cost: '0.5' }] };
    return undefined;
  });
  const result = await callRoute(pool, 'get', '/projects/:slug/budget/roles', { slug: 'mainty' });
  const roles = (result.body as { roles: { role: string; limits: Record<string, unknown> }[] }).roles;
  assert.deepEqual(
    roles.map((entry) => entry.role),
    ['author', 'developer', 'tester', 'reviewer', 'documenter', 'bug_reviewer', 'manual_writer', 'user_manual_writer'],
  );
  const developer = roles.find((entry) => entry.role === 'developer');
  assert.deepEqual(developer?.limits.day, { maxTokens: 500000, spend: { tokens: 125000, costUsd: 0.5 }, percent: 25 });
  // Ohne aktiven Sprint kein Sprintverbrauch; das Auftragslimit hängt am einzelnen Auftrag.
  assert.deepEqual(developer?.limits.sprint, { maxTokens: null, spend: null, percent: null });
  assert.deepEqual(developer?.limits.order, { maxTokens: null, spend: null, percent: null });
  const tester = roles.find((entry) => entry.role === 'tester');
  assert.deepEqual(tester?.limits.day, { maxTokens: null, spend: { tokens: 0, costUsd: 0 }, percent: null });
});

test('Rollen-Limits ändern nur mit „admin“ (403 ohne), lesen für Projektmitglieder', async () => {
  const path = '/api/projects/mainty/budget/roles/developer';
  assert.equal(requiredRole('PUT', path, {}), 'admin');
  const pool = {
    query: async () => ({ rows: [{ slug: 'mainty' }] }),
  } as unknown as Pool;
  const planner: Principal = {
    id: '2d6f1c7e-1d2a-4c3b-9e8f-112233445566',
    username: 'ana',
    displayName: 'Ana',
    roles: ['plan'],
  };
  assert.equal(await guardStatus(pool, planner, 'PUT', path, { day: { maxTokens: 1 } }), 403);
  assert.equal(await guardStatus(pool, { ...planner, roles: ['admin'] }, 'PUT', path, { day: { maxTokens: 1 } }), 200);
  assert.equal(await guardStatus(pool, planner, 'GET', '/api/projects/mainty/budget/roles'), 200);
});
