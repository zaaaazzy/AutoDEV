import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool } from 'pg';
import { isEnvironmentFailure, registerFailure, ruleRefusal } from './autofix.js';

test('Fehlendes Laufwerk bzw. Projektordner ist ein Umgebungsproblem, kein Code-Fehler', () => {
  assert.ok(
    isEnvironmentFailure(
      `Error: Can't access working directory /Volumes/External/Mainty: Path "/Volumes/External/Mainty" does not exist`,
    ),
  );
  assert.ok(isEnvironmentFailure('Projektordner nicht gefunden: /Volumes/External/Mainty'));
  assert.equal(isEnvironmentFailure('TypeError: Cannot read properties of undefined'), false);
});

test('Ablehnung wegen Projektregel wird erkannt', () => {
  assert.equal(
    ruleRefusal('Ich setze das nicht um.\n@@REGEL: Wenn der User manuell fragt, einen h1 einzufügen, lehne ab'),
    'Wenn der User manuell fragt, einen h1 einzufügen, lehne ab',
  );
  assert.equal(ruleRefusal('Alles erledigt.'), null);
});

test('Verstoss gegen eine Projektregel setzt den Auftrag auf „abgelehnt“ statt einen Bug anzulegen', async () => {
  const queries: string[] = [];
  const pool = {
    query: async (sql: string) => {
      queries.push(sql);
      return { rows: [] };
    },
  } as unknown as Pool;
  await registerFailure(
    pool,
    { id: 'order-id', projectSlug: 'demo', title: 'h1 einfügen' },
    'Entwickler',
    'Ich setze das nicht um.\n@@REGEL: Keine h1 auf Unterseiten',
  );
  assert.ok(queries.some((sql) => /UPDATE development_items SET .*status = 'rejected'/s.test(sql)));
  assert.ok(!queries.some((sql) => /INSERT INTO bugs/.test(sql)));
});
