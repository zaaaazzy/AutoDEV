import assert from 'node:assert/strict';
import { test } from 'node:test';
import { failureParts, orderGuide, orderProblem } from './order-problem.js';

test('Ohne Handlungsbedarf keine Kurzfassung – auch nicht mit altem Hinweis bei Erledigten', () => {
  assert.equal(orderProblem({ status: 'done' }), null);
  assert.equal(orderProblem({ status: 'done', actionTodo: 'Zugang geben' }), null);
  assert.equal(orderProblem({ status: 'rejected', actionTodo: 'Zugang geben' }), null);
});

test('Hinweis „Problem – Lösung“ wird getrennt, statt zweimal denselben Text zu zeigen', () => {
  assert.deepEqual(
    orderProblem({
      status: 'blocked',
      actionTodo: 'Projektregel verhindert den Auftrag: keine h1 – Auftrag anpassen oder verwerfen',
    }),
    { problem: 'Projektregel verhindert den Auftrag: keine h1', solution: 'Auftrag anpassen oder verwerfen' },
  );
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

const ANALYSIS = [
  '**Bug:** Arbeit landet im falschen Commit',
  '',
  '## Ursache',
  'Es sind zwei Probleme, die sich überlagern:',
  '',
  '1. **Die Arbeit steckt in einem fremden Commit.** Der Entwickler hat im gemeinsamen Ordner gearbeitet.',
  '   - `src/agent/visionary.ts`',
  '2. **Der zweite Lauf wurde von außen beendet.** Der Worker wurde neu gestartet.',
  '',
  '## Lösung (konkrete Schritte)',
  '1. **Testskript in `package.json` aufteilen:**',
  '   ```json',
  '   "test": "npm run test:unit"',
  '   ```',
  '2. **`measureCoverage()` robuster machen** (`src/runner/measured-coverage.ts`):',
  '3. **Skript** in `package.json`: `"test:coverage": "tsx --test **/*.test.ts"`.',
  '4. **Prüfen:** `npm run test:coverage` lokal ausführen.',
  '5. Danach den Tester erneut starten.',
].join('\n');

test('Endet die Ursache mit „:“, folgen die Kernaussagen statt eines abgeschnittenen Satzes', () => {
  const summary = orderProblem({ status: 'blocked', analysis: ANALYSIS })!;
  assert.match(summary.problem, /^Es sind zwei Probleme, die sich überlagern: Die Arbeit steckt/);
  assert.match(summary.solution, /^Testskript in package\.json aufteilen; measureCoverage\(\) robuster machen/);
});

test('Unterstriche in Namen bleiben erhalten', () => {
  assert.equal(
    orderProblem({ status: 'blocked', actionTodo: 'WEBAUTHN_RP_ID fehlt – in .env eintragen' })!.problem,
    'WEBAUTHN_RP_ID fehlt',
  );
});

test('Anleitung: Teilursachen und Schritte einzeln, ohne Codeblöcke und Unterpunkte', () => {
  assert.deepEqual(orderGuide({ status: 'blocked', analysis: ANALYSIS }), {
    problem: 'Es sind zwei Probleme, die sich überlagern:',
    causes: ['Die Arbeit steckt in einem fremden Commit', 'Der zweite Lauf wurde von außen beendet'],
    steps: [
      'Testskript in package.json aufteilen',
      'measureCoverage() robuster machen',
      'Skript in package.json',
      'Prüfen: npm run test:coverage lokal ausführen',
      'Danach den Tester erneut starten',
    ],
    nothingToFix: false,
  });
});

test('Anleitung: „keine (…)“ heißt, dass du nichts beheben musst', () => {
  const guide = orderGuide({
    status: 'blocked',
    analysis: ANALYSIS,
    actionTodo:
      'keine (die Agents können es selbst beheben). Ein Mensch muss nur den Auftrag neu starten und darf den Worker währenddessen nicht neu starten.',
  })!;
  assert.equal(guide.nothingToFix, true);
  assert.deepEqual(guide.steps, [
    'Nichts selbst beheben – die Agents können es selbst beheben.',
    'Ein Mensch muss nur den Auftrag neu starten und darf den Worker währenddessen nicht neu starten.',
  ]);
});

test('Anleitung: Hinweis „Problem – Lösung“ und Fälle ohne Handlungsbedarf', () => {
  assert.deepEqual(orderGuide({ status: 'blocked', actionTodo: 'WEBAUTHN_RP_ID fehlt – in .env eintragen' }), {
    problem: 'WEBAUTHN_RP_ID fehlt',
    causes: [],
    steps: ['in .env eintragen'],
    nothingToFix: false,
  });
  assert.equal(orderGuide({ status: 'done', actionTodo: 'x' }), null);
  assert.equal(orderGuide({ status: 'rejected' }), null);
  assert.deepEqual(orderGuide({ status: 'blocked', failure: 'Agent „Tester“ scheiterte:\n\nError: 401' })!.steps, []);
});

test('Ausführliche Meldung: Abnahmepunkte, Bericht, letzter Vermerk und Testprotokoll getrennt', () => {
  const parts = failureParts(
    [
      'Agent „Tester“ scheiterte:',
      '',
      'bdeckung konnte ich nicht messen. Der Wächter blockiert den Befehl.',
      '',
      '## Testlauf (Projekttests)',
      '$ npm test → passed',
      '',
      '## Abnahme nicht bestanden',
      '- DoD 3 „Abdeckung mindestens 75 %“: Abdeckung nicht messbar',
      '- Sonstiges ohne Kriterium',
      '',
      '**Vermerk der Problemanalyse:** kein Code-Fehler – Aktion notwendig: keine.',
      '',
      '**Vermerk der Problemanalyse:** Code-Fehler bestätigt („Abdeckung fehlt“) – an einen Behebungsauftrag delegiert.',
    ].join('\n'),
  );
  assert.deepEqual(parts, {
    agent: 'Tester',
    unmet: [
      { label: 'DoD 3', criterion: 'Abdeckung mindestens 75 %', reason: 'Abdeckung nicht messbar' },
      { label: '', criterion: 'Sonstiges ohne Kriterium', reason: '' },
    ],
    report: '…konnte ich nicht messen. Der Wächter blockiert den Befehl.',
    note: 'Code-Fehler bestätigt („Abdeckung fehlt“) – an einen Behebungsauftrag delegiert.',
    log: '$ npm test → passed',
  });
});
