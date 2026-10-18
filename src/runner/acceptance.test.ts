import assert from 'node:assert/strict';
import test from 'node:test';
import { acceptanceProblems, extractCriteria, manualChecks, parseAcceptance, stripAcceptance } from './acceptance.js';

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
