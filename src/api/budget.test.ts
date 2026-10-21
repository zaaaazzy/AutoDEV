import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';
import { collectBudget, loadDisplay, parseBudgetInput, saveBudget } from './budget.js';
import { requiredRole } from './route-table.test.js';

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
