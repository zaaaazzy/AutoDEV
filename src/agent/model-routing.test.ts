import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';
import {
  DEFAULT_RULES,
  describeCommand,
  loadRouting,
  matchesCondition,
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

test('matchesCondition: jede Teilbedingung einzeln, fehlende Werte treffen nicht zu', () => {
  assert.ok(matchesCondition({}, input()));
  assert.ok(!matchesCondition({ categories: ['docs'] }, input()), 'ohne Kategorie');
  assert.ok(matchesCondition({ categories: [] }, input()), 'leere Liste schränkt nicht ein');
  assert.ok(!matchesCondition({ minHours: 2 }, input()), 'ohne Schätzung');
  assert.ok(!matchesCondition({ maxHours: 2 }, input()), 'ohne Schätzung');
  assert.ok(!matchesCondition({ maxHours: 2 }, input({ effortHours: 2 })), 'Grenze exklusiv');
  assert.ok(matchesCondition({ maxHours: 2 }, input({ effortHours: 1.9 })));
  assert.ok(!matchesCondition({ minRetries: 2 }, input({ retryCount: 1 })));
  assert.ok(matchesCondition({ minRetries: 2 }, input({ retryCount: 2 })));
  assert.ok(!matchesCondition({ minBudgetPercent: 50 }, input({ budgetPercent: 50 })));
});

test('routeModel: „tiefer“ ohne Grundstufe heißt lokal; mehrere Verschiebungen in Reihenfolge', () => {
  assert.deepEqual(routeModel([{ condition: {}, tier: 'down' }], input()), {
    tier: 'local',
    rule: 'immer → eine Stufe tiefer',
  });
  const decision = routeModel(
    [
      { condition: {}, tier: 'down' },
      { condition: {}, tier: 'up' },
    ],
    input(),
  );
  assert.equal(decision.tier, 'strong', 'die letzte Verschiebung gewinnt');
});

test('ruleLabel: alle Teile mit Komma-Dezimalzahl', () => {
  assert.equal(
    ruleLabel({
      condition: {
        categories: ['frontend', 'backend'],
        minHours: 1.5,
        maxHours: 8,
        minRetries: 2,
        minBudgetPercent: 90,
      },
      tier: 'strong',
    }),
    'frontend/backend, Schätzung > 1,5 h, Schätzung < 8 h, retry ≥ 2, Budget > 90 % → stark',
  );
});

test('parseRules: Grenzen und ungültige Einträge', () => {
  assert.match(
    String(parseRules(Array.from({ length: 31 }, () => ({ condition: {}, tier: 'local' })))),
    /höchstens 30/,
  );
  assert.equal(
    (parseRules(Array.from({ length: 30 }, () => ({ condition: {}, tier: 'local' }))) as unknown[]).length,
    30,
  );
  assert.match(String(parseRules([null])), /Regel 1: ungültig/);
  assert.match(String(parseRules([{ condition: {}, tier: 'up' }, 'x'])), /Regel 2: ungültig/);
  assert.match(String(parseRules([{ condition: { categories: 'docs' }, tier: 'local' }])), /Kategorie/);
  assert.match(String(parseRules([{ condition: { minRetries: 101 }, tier: 'up' }])), /Zahlen/);
  assert.match(String(parseRules([{ condition: { minHours: -1 }, tier: 'up' }])), /Zahlen/);
  assert.match(String(parseRules([{ condition: { maxHours: 'viel' }, tier: 'up' }])), /Zahlen/);
  // Fehlende Bedingung, null und leere Kategorien ergeben eine leere Bedingung.
  assert.deepEqual(
    parseRules([
      { tier: 'local' },
      { condition: null, tier: 'strong' },
      { condition: { categories: [], minRetries: null, minBudgetPercent: 100 }, tier: 'down' },
    ]),
    [
      { condition: {}, tier: 'local' },
      { condition: {}, tier: 'strong' },
      { condition: { minBudgetPercent: 100 }, tier: 'down' },
    ],
  );
  assert.deepEqual(parseRules([]), []);
});

test('loadRouting: ungültige eigene Regeln ergeben keine Regeln, fehlendes Projekt die Standardregeln', async () => {
  const broken = {
    query: async (sql: string) =>
      sql.includes('FROM projects')
        ? { rows: [{ customized: true, local: '  ', strong: 'claude -p' }] }
        : { rows: [{ condition: {}, tier: 'turbo' }] },
  } as unknown as Pool;
  assert.deepEqual(await loadRouting(broken, 'p'), {
    rules: [],
    customized: true,
    models: { local: null, strong: null },
  });
  const missing = { query: async () => ({ rows: [] }) } as unknown as Pool;
  const routing = await loadRouting(missing, 'p');
  assert.equal(routing.rules, DEFAULT_RULES);
  assert.equal(routing.customized, false);
  assert.deepEqual(routing.models, { local: null, strong: null });
});

test('describeCommand: -m, leere Befehle und Windows-Pfade', () => {
  assert.equal(describeCommand(['codex', '-m', 'gpt']), 'codex (gpt)');
  assert.equal(describeCommand(['claude', '--model']), 'claude');
  assert.equal(describeCommand(['C:\\tools\\claude.exe']), 'claude.exe');
  assert.equal(describeCommand([]), '');
  assert.ok(routable('reviewer'));
});

test('Modellname eines CLI-Befehls und Rollen ohne Routing', () => {
  assert.equal(describeCommand(['claude', '-p', '--model', 'opus']), 'claude (opus)');
  assert.equal(describeCommand(['/usr/local/bin/claude', '--model=sonnet']), 'claude (sonnet)');
  assert.equal(describeCommand(['codex', 'exec']), 'codex');
  assert.equal(routable('tester'), false);
  assert.equal(routable('developer'), true);
});
