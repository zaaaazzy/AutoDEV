import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';
import {
  DEFAULT_RULES,
  describeCommand,
  loadRouting,
  parseRules,
  routable,
  routeModel,
  ruleLabel,
  type RoutingInput,
} from './model-routing.js';

const input = (overrides: Partial<RoutingInput> = {}): RoutingInput => ({
  category: null,
  effortHours: null,
  retryCount: 0,
  budgetPercent: 0,
  ...overrides,
});

test('Standardregel: Kategorie docs läuft lokal', () => {
  assert.deepEqual(routeModel(DEFAULT_RULES, input({ category: 'docs', effortHours: 3 })), {
    tier: 'local',
    rule: 'docs → lokal',
  });
});

test('Standardregel: Schätzung unter 1 h läuft lokal, backend über 4 h stark', () => {
  assert.equal(routeModel(DEFAULT_RULES, input({ category: 'frontend', effortHours: 0.5 })).tier, 'local');
  const backend = routeModel(DEFAULT_RULES, input({ category: 'backend', effortHours: 6 }));
  assert.deepEqual(backend, { tier: 'strong', rule: 'backend, Schätzung > 4 h → stark' });
  // Ohne Schätzung oder an der Grenze greift keine Stufen-Regel: die Modellwahl je Rolle bleibt.
  assert.deepEqual(routeModel(DEFAULT_RULES, input({ category: 'backend', effortHours: 4 })), {
    tier: null,
    rule: null,
  });
  assert.equal(routeModel(DEFAULT_RULES, input({ category: 'frontend' })).tier, null);
});

test('retry_count ≥ 1 eskaliert eine Stufe höher', () => {
  const decision = routeModel(DEFAULT_RULES, input({ category: 'docs', retryCount: 1 }));
  assert.equal(decision.tier, 'strong');
  assert.equal(decision.rule, 'docs → lokal · retry ≥ 1 → eine Stufe höher');
  // Ohne Grundstufe heißt „höher“: stark.
  assert.equal(routeModel(DEFAULT_RULES, input({ retryCount: 2 })).tier, 'strong');
});

test('Budget über 80 % wählt eine Stufe tiefer (Sparmodus)', () => {
  const decision = routeModel(DEFAULT_RULES, input({ category: 'backend', effortHours: 8, budgetPercent: 85 }));
  assert.equal(decision.tier, 'local');
  assert.match(decision.rule ?? '', /Budget > 80 % → eine Stufe tiefer$/);
  // Genau 80 % ist noch kein Sparmodus.
  assert.equal(
    routeModel(DEFAULT_RULES, input({ category: 'backend', effortHours: 8, budgetPercent: 80 })).tier,
    'strong',
  );
});

test('die Reihenfolge bestimmt die Grundstufe; eine leere Bedingung trifft immer zu', () => {
  const rules = [
    { condition: {}, tier: 'strong' as const },
    { condition: { categories: ['docs'] }, tier: 'local' as const },
  ];
  assert.deepEqual(routeModel(rules, input({ category: 'docs' })), { tier: 'strong', rule: 'immer → stark' });
  assert.deepEqual(routeModel([], input({ category: 'docs' })), { tier: null, rule: null });
});

test('Regeln aus der Oberfläche werden geprüft und bereinigt', () => {
  assert.deepEqual(
    parseRules([{ condition: { categories: ['docs', 'docs'], maxHours: '1', minHours: '' }, tier: 'local' }]),
    [{ condition: { categories: ['docs'], maxHours: 1 }, tier: 'local' }],
  );
  assert.match(String(parseRules([{ condition: { categories: ['marketing'] }, tier: 'local' }])), /Kategorie/);
  assert.match(String(parseRules([{ condition: {}, tier: 'turbo' }])), /Stufe/);
  assert.match(String(parseRules([{ condition: { minBudgetPercent: 150 }, tier: 'down' }])), /Zahlen/);
  assert.match(String(parseRules('x')), /Liste/);
  assert.equal(ruleLabel({ condition: { minRetries: 1 }, tier: 'up' }), 'retry ≥ 1 → eine Stufe höher');
});

test('ohne eigene Regeln gelten die Standardregeln; Stufen-Modelle kommen aus dem Projekt', async () => {
  const pool = {
    query: async (sql: string) =>
      sql.includes('FROM projects')
        ? { rows: [{ customized: false, local: ' qwen3.5:9b ', strong: ['claude', '-p'] }] }
        : { rows: [{ condition: { categories: ['frontend'] }, tier: 'strong' }] },
  } as unknown as Pool;
  const routing = await loadRouting(pool, 'mainty');
  assert.equal(routing.rules, DEFAULT_RULES);
  assert.deepEqual(routing.models, { local: 'qwen3.5:9b', strong: ['claude', '-p'] });

  const custom = {
    query: async (sql: string) =>
      sql.includes('FROM projects')
        ? { rows: [{ customized: true, local: null, strong: null }] }
        : { rows: [{ condition: { categories: ['frontend'] }, tier: 'strong' }] },
  } as unknown as Pool;
  const customRouting = await loadRouting(custom, 'mainty');
  assert.deepEqual(customRouting.rules, [{ condition: { categories: ['frontend'] }, tier: 'strong' }]);
  assert.deepEqual(customRouting.models, { local: null, strong: null });
});

test('Modellname eines CLI-Befehls und Rollen ohne Routing', () => {
  assert.equal(describeCommand(['claude', '-p', '--model', 'opus']), 'claude (opus)');
  assert.equal(describeCommand(['/usr/local/bin/claude', '--model=sonnet']), 'claude (sonnet)');
  assert.equal(describeCommand(['codex', 'exec']), 'codex');
  assert.equal(routable('tester'), false);
  assert.equal(routable('developer'), true);
});
