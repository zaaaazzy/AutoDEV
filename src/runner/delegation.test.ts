import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isEnvironmentFailure, ruleRefusal } from './autofix.js';

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
