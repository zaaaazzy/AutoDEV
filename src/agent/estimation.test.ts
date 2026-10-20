import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';
import { loadActualReference, parseEstimate, referenceSection, splitEstimate } from './estimation.js';
import { buildRequirementPrompt } from './requirements.js';

test('lernende Schätzung: Median-Ist-Werte erledigter Aufträge derselben Kategorie im Autor-Prompt', async () => {
  const queries: unknown[][] = [];
  const pool = {
    query: async (_sql: string, values: unknown[]) => {
      queries.push(values);
      return { rows: [{ count: '3', hours: '1.25', tokens: '42000.5' }] };
    },
  } as unknown as Pool;
  const reference = await loadActualReference(pool, 'mainty', 'docs');
  assert.deepEqual(reference, { category: 'docs', count: 3, medianHours: 1.3, medianTokens: 42001 });
  assert.deepEqual(queries[0], ['mainty', 'docs']);
  const idea = { id: 'i', projectSlug: 'mainty', title: 'Doku', description: 'x', priority: 'medium', comments: [] };
  const prompt = buildRequirementPrompt('', idea, undefined, undefined, reference);
  assert.match(prompt, /## Ist-Werte ähnlicher erledigter Aufträge/);
  assert.match(prompt, /3 erledigte Aufträge der Kategorie „docs“: Median 1,3 h Agent-Laufzeit und 42001 Tokens/);
  // Ohne erledigte Aufträge kein Abschnitt.
  const none = { query: async () => ({ rows: [{ count: '0', hours: null, tokens: null }] }) } as unknown as Pool;
  assert.equal(await loadActualReference(none, 'mainty', null), null);
  assert.doesNotMatch(buildRequirementPrompt('', idea), /Ist-Werte/);
  assert.match(referenceSection({ category: null, count: 1, medianHours: 2, medianTokens: 5 }), /ohne Kategorie/);
});

test('splitEstimate separates the requirement from the estimate section', () => {
  const output =
    '## Ziel\nLogin\n\n## Schätzung\n```json\n{"effortHours": 3, "tokenEstimate": 120000, "benefit": 7, "cost": 4}\n```';
  const { requirement, estimate } = splitEstimate(output);
  assert.equal(requirement, '## Ziel\nLogin');
  assert.deepEqual(estimate, { effortHours: 3, tokenEstimate: 120000, benefit: 7, cost: 4 });
});

test('splitEstimate keeps the text when the estimate is missing or invalid', () => {
  assert.deepEqual(splitEstimate('## Ziel\nNur Text'), { requirement: '## Ziel\nNur Text', estimate: null });
  assert.equal(splitEstimate('## Ziel\nX\n## Schätzung\nkeine Ahnung').estimate, null);
  assert.equal(splitEstimate('## Ziel\nX\n## Schätzung\n{"effortHours": -5}').estimate, null);
});

test('parseEstimate reads a bare JSON answer', () => {
  assert.equal(parseEstimate('{"effortHours": 2, "tokenEstimate": 5000}')?.effortHours, 2);
  assert.equal(parseEstimate('kein json'), null);
});

test('parseEstimate ignores braces in CLI banners and logs', () => {
  const output = 'warn {deprecated} flag\n{"effortHours": 3, "benefit": 7}\nlog: {done}';
  assert.equal(parseEstimate(output)?.effortHours, 3);
  assert.equal(parseEstimate(output)?.benefit, 7);
});
