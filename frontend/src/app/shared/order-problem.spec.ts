import assert from 'node:assert/strict';
import { test } from 'node:test';
import { orderProblem } from './order-problem.js';

test('Ohne Handlungsbedarf keine Kurzfassung', () => {
  assert.equal(orderProblem({ status: 'done' }), null);
});

test('Problem aus der Analyse, Lösung aus der Aktion', () => {
  assert.deepEqual(
    orderProblem({
      status: 'blocked',
      failure: 'Agent „Tester“ scheiterte:\n\nError: 401',
      analysis:
        '**Bug:** Login\n\n## Ursache\nDer API-Schlüssel fehlt in der .env.\n\n## Lösung (konkrete Schritte)\n1. Schlüssel eintragen',
      actionTodo: 'API-Schlüssel in .env eintragen',
    }),
    { problem: 'Der API-Schlüssel fehlt in der .env.', solution: 'API-Schlüssel in .env eintragen' },
  );
});

test('Ohne Analyse: Vermerk bzw. erste Fehlerzeile, Lösung aus der Analyse oder Standard', () => {
  assert.deepEqual(
    orderProblem({
      status: 'blocked',
      failure: 'Agent „Entwickler“ hat angehalten.\n\n**Vermerk:** Umgebung – Laufwerk nicht erreichbar.',
    }),
    { problem: 'Laufwerk nicht erreichbar.', solution: 'Erneut versuchen oder vom Assistenten analysieren lassen' },
  );
  assert.equal(
    orderProblem({ status: 'blocked', failure: 'Agent „Tester“ scheiterte:\n\nTypeError: x is undefined' })!.problem,
    'TypeError: x is undefined',
  );
  assert.equal(
    orderProblem({ status: 'blocked', failure: 'Agent „Tester“ scheiterte: Error: 401 Unauthorized' })!.problem,
    'Error: 401 Unauthorized',
  );
});
