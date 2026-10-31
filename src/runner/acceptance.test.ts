import assert from 'node:assert/strict';
import test from 'node:test';
import {
  acceptanceProblems,
  extractCriteria,
  manualChecks,
  parseAcceptance,
  stripAcceptance,
  waiveUnmeasuredCoverage,
} from './acceptance.js';

const ORDER = `## Ziel
Login-Seite modernisieren.

## Anforderungen (Liste)
- Neues Layout

## Akzeptanzkriterien (Liste, prüfbar)
1. **Fehlermeldung** erscheint bei falschem Passwort.
2. [ ] Der Button ist ohne Eingaben deaktiviert.
- Tastatur-Bedienung funktioniert.

## Abgrenzung
- Kein Passwort-Reset`;

test('reads the acceptance criteria list up to the next heading', () => {
  assert.deepEqual(extractCriteria(ORDER), [
    'Fehlermeldung erscheint bei falschem Passwort.',
    'Der Button ist ohne Eingaben deaktiviert.',
    'Tastatur-Bedienung funktioniert.',
  ]);
  assert.deepEqual(extractCriteria('## Ziel\nNur Text'), []);
});

test('evaluates the tester acceptance block and lists open points', () => {
  const output = `Alles geprüft.\n@@ACCEPTANCE {"criteria":[{"nr":1,"met":true,"note":"Test login.spec"},{"nr":2,"met":false,"note":"Button bleibt aktiv"}],"done":[{"nr":1,"met":true}]}`;
  const result = parseAcceptance(output, 3, 2);
  assert.ok(result);
  assert.equal(result.criteria.length, 2);
  assert.deepEqual(acceptanceProblems(result, ['A', 'B', 'C'], ['Tests grün', 'Doku']), [
    'Kriterium 2 „B“: Button bleibt aktiv',
    'Kriterium 3 „C“: nicht geprüft',
    'DoD 2 „Doku“: nicht geprüft',
  ]);
  assert.equal(stripAcceptance(output), 'Alles geprüft.');
  assert.equal(parseAcceptance('kein Block', 1, 1), null);
});

test('points only a human can check do not fail the acceptance', () => {
  const output = `@@ACCEPTANCE {"criteria":[{"nr":1,"met":true},{"nr":2,"met":false,"manual":true,"note":"Redirect-URI bei Google anpassen"}],"done":[{"nr":1,"met":true}]}`;
  const result = parseAcceptance(output, 2, 1);
  assert.ok(result);
  assert.deepEqual(acceptanceProblems(result, ['A', 'Google-Login'], ['Tests grün']), []);
  assert.deepEqual(manualChecks(result, ['A', 'Google-Login']), ['Google-Login – Redirect-URI bei Google anpassen']);
});

test('the last acceptance block wins over an interim one', () => {
  const output = [
    '@@ACCEPTANCE {"criteria":[{"nr":1,"met":true}],"done":[{"nr":1,"met":true}]}',
    'Nachprüfung: Kriterium 1 doch nicht erfüllt.',
    '@@ACCEPTANCE {"criteria":[{"nr":1,"met":false,"note":"Fehlt"}],"done":[{"nr":1,"met":true}]}',
  ].join('\n');
  const result = parseAcceptance(output, 1, 1);
  assert.equal(result?.criteria[0]?.met, false);
  assert.equal(stripAcceptance(output), '\nNachprüfung: Kriterium 1 doch nicht erfüllt.');
});

test('Abnahme-Anweisung: fehlende Abdeckungsmessung ist kein Ablehnungsgrund', async () => {
  const { acceptanceInstructions } = await import('./acceptance.js');
  const { COVERAGE_INSTRUCTIONS } = await import('./coverage.js');
  assert.match(acceptanceInstructions(['A'], ['Jedes Kriterium ist durch einen Test belegt']), /allein kein Grund/);
  assert.match(COVERAGE_INSTRUCTIONS, /kein Grund, die Abnahme abzulehnen/);
});

test('Abnahme: ein ausgelassener DoD-Punkt bleibt „nicht geprüft“; die Anweisung verlangt jeden Punkt', async () => {
  const { acceptanceInstructions, acceptanceProblems } = await import('./acceptance.js');
  const done = [
    'Tests grün',
    'Manuelle Kriterien nur in begründeten Ausnahmen',
    'Abgenommen wird per Freigabe in der Vorschau',
  ];
  const instructions = acceptanceInstructions(['A'], done);
  // Das Beispiel nennt jede DoD-Nummer, damit kein Punkt wegfällt.
  const example = JSON.parse(/^@@ACCEPTANCE (.*)$/m.exec(instructions)?.[1] ?? '{}') as { done: { nr: number }[] };
  assert.deepEqual(
    example.done.map((entry) => entry.nr),
    [1, 2, 3],
  );
  assert.match(instructions, /alle 3 DoD-Punkte/);
  // Ausgelassen bleibt abgelehnt; als manuell gemeldet blockiert der Punkt nicht.
  const criteria = [{ nr: 1, met: true, note: '' }];
  assert.deepEqual(
    acceptanceProblems({ criteria, done: [{ nr: 1, met: true, note: '' }] }, ['A'], done).map((line) =>
      line.slice(0, 5),
    ),
    ['DoD 2', 'DoD 3'],
  );
  const reported = [
    { nr: 1, met: true, note: '' },
    { nr: 2, met: true, note: '' },
    { nr: 3, met: false, manual: true, note: 'Freigabe in der Vorschau' },
  ];
  assert.deepEqual(acceptanceProblems({ criteria, done: reported }, ['A'], done), []);
});

const UNMEASURED = 'Abdeckung nicht gemessen (Wächter blockiert den Befehl)';
const tested = {
  criteria: [{ nr: 1, met: true, note: 'Test a' }],
  done: [{ nr: 3, met: false, note: UNMEASURED }],
};

test('waiveUnmeasuredCoverage: nur mit gültiger Messung durch AIdeation gilt der Abdeckungspunkt als erfüllt', () => {
  const measured = waiveUnmeasuredCoverage(tested, 1, true);
  assert.deepEqual(measured.waived, [3]);
  assert.equal(measured.result.done[0]?.met, true);
  // Ohne gültigen Bericht (keine Messung, ungültiger Block verworfen) bleibt der Punkt offen.
  const missing = waiveUnmeasuredCoverage(tested, 1, false);
  assert.deepEqual(missing.waived, []);
  assert.equal(missing.result.done[0]?.met, false);
});

test('waiveUnmeasuredCoverage: ein Hinweis auf null-Werte allein ist kein Ausnahmefall mehr', () => {
  const result = waiveUnmeasuredCoverage(
    { criteria: tested.criteria, done: [{ nr: 3, met: false, note: 'Abdeckung als null gemeldet' }] },
    1,
    true,
  );
  assert.deepEqual(result.waived, []);
});
