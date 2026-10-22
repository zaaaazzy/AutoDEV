import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';
import { buildTroubleshootPrompt, collectFailures, parseAnalysis } from './troubleshoot.js';

/** Fake-Pool: liefert Schritte und Blockiergrund des Auftrags, merkt sich die Abfragen. */
function fakePool(
  steps: { agent: string; output: string }[],
  item: { failure: string | null; actionTodo: string | null },
) {
  const queries: { text: string; values: unknown[] }[] = [];
  const pool = {
    query: async (text: string, values: unknown[] = []) => {
      queries.push({ text, values });
      if (/FROM agent_run_steps/.test(text)) return { rows: steps };
      if (/FROM development_items/.test(text)) return { rows: [item] };
      return { rows: [] };
    },
  } as unknown as Pool;
  return { pool, queries };
}

const ORDER = { title: 'Login', description: 'Login bauen.' };

test('parses the bug title from the troubleshooter answer', () => {
  const parsed = parseAnalysis('TITEL: jest nicht installiert\n## Ursache\nFehlt.', 'Fallback');
  assert.equal(parsed.title, 'jest nicht installiert');
  assert.match(parsed.body, /^## Ursache/);
  assert.equal(parseAnalysis('## Ursache\nx', 'Fallback').title, 'Fallback');
});

test('includes failures and the answer format in the prompt', () => {
  const prompt = buildTroubleshootPrompt(
    '',
    { title: 'A', description: 'B' },
    ['### Tester\njest: command not found'],
    [],
  );
  assert.match(prompt, /jest: command not found/);
  assert.match(prompt, /TITEL:/);
});

test('Problemanalyse: Blockiergrund und offene Aktion stehen im Prompt, auch ohne fehlgeschlagenen Schritt', async () => {
  const { pool, queries } = fakePool([], {
    failure: 'Auftrags-Branch nicht betretbar: fremde, nicht committete Änderungen in src/a.ts',
    actionTodo: 'Änderungen im Projektordner committen oder verwerfen',
  });
  const failures = await collectFailures(pool, 'd1');
  const prompt = buildTroubleshootPrompt('', ORDER, failures, []);
  assert.match(prompt, /### Blockiergrund des Auftrags\nAuftrags-Branch nicht betretbar: fremde, nicht committete/);
  assert.match(prompt, /### Offene Aktion\nÄnderungen im Projektordner committen oder verwerfen/);
  assert.doesNotMatch(prompt, /Keine Fehlerausgabe vorhanden/);
  assert.ok(queries.every((query) => query.values[0] === 'd1'));
});

test('Problemanalyse: leere Felder ergeben keinen Abschnitt, Schritte bleiben, langer Grund wird gekürzt', async () => {
  const empty = await collectFailures(fakePool([], { failure: null, actionTodo: '  ' }).pool, 'd1');
  assert.deepEqual(empty, []);
  assert.match(buildTroubleshootPrompt('', ORDER, empty, []), /Keine Fehlerausgabe vorhanden\./);

  const steps = [{ agent: 'Tester', output: 'jest: command not found' }];
  const failures = await collectFailures(
    fakePool(steps, { failure: `Grund ${'x'.repeat(5000)}`, actionTodo: null }).pool,
    'd1',
  );
  assert.equal(failures.length, 2);
  assert.match(failures[0]!, /^### Blockiergrund des Auftrags\nGrund x/);
  assert.ok(failures[0]!.length <= 2600, 'Grund auf die Längengrenze gekürzt');
  assert.equal(failures[1], '### Tester\njest: command not found');
});

test('Problemanalyse: Geheimnisse im Blockiergrund werden geschwärzt', async () => {
  process.env.TROUBLESHOOT_TEST_TOKEN = 'geheim-98765';
  try {
    const failures = await collectFailures(
      fakePool([], { failure: 'Push fehlgeschlagen mit geheim-98765', actionTodo: null }).pool,
      'd1',
    );
    assert.ok(!failures.join('\n').includes('geheim-98765'));
  } finally {
    delete process.env.TROUBLESHOOT_TEST_TOKEN;
  }
});
