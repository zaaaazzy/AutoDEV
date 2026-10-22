import assert from 'node:assert/strict';
import test from 'node:test';
import { gateFailureSummary } from './git-sync/ci.js';

// Ausgabe von test:full wie im gescheiterten Gate von Sprint 17: ein roter Schritt, danach viele bestandene Tests.
const sprint17 = [
  '━━ Lint: grün ━━',
  '✖ 616 problems (0 errors, 616 warnings)',
  '━━ Formatierung: rot ━━',
  'Checking formatting...',
  '[warn] src/agent/tool-sql-guard.test.ts',
  '[warn] Code style issues found in the above file. Run Prettier with --write to fix.',
  '━━ Unit-Tests (inkl. UI-Build): grün ━━',
  ...Array.from({ length: 40 }, (_, index) => `ok ${index + 211} - read_file: lange Ausgaben werden gekürzt`),
  '# tests 1096',
  '# fail 0',
].join('\n');

// Wie im Gate von Sprint 16: E2E rot, der Grund steht in den Playwright-Zeilen.
const sprint16 = [
  '━━ E2E-Tests: rot ━━',
  '  ✓  8 [desktop] › e2e/app.spec.ts:180:1 › Dashboard (1.2s)',
  '  ✘  9 [desktop] › e2e/app.spec.ts:206:1 › Einstellungen: DoR/DoD, Zwei-Faktor einrichten (7.1s)',
  '    Error: expect(locator).toBeVisible() failed',
  '  ✘  42 [handy] › e2e/app.spec.ts:206:1 › Einstellungen: DoR/DoD, Zwei-Faktor einrichten (6.7s)',
  '  61 passed, 2 failed, 3 skipped',
].join('\n');

test('Gate-Meldung nennt den roten Schritt und den Befund statt bestandener Tests vom Ende', () => {
  const summary = gateFailureSummary(sprint17);
  assert.match(summary, /^Rot: Formatierung\. \[warn\] src\/agent\/tool-sql-guard\.test\.ts/);
  assert.doesNotMatch(summary, /read_file|0 errors|# fail 0/);
});

test('Gate-Meldung: Playwright-Fehlschläge mit Testname und Fehlerzeile', () => {
  const summary = gateFailureSummary(sprint16);
  assert.match(summary, /^Rot: E2E-Tests\./);
  assert.match(summary, /✘ {2}9 \[desktop\] › e2e\/app\.spec\.ts:206:1 › Einstellungen/);
  assert.match(summary, /Error: expect\(locator\)\.toBeVisible\(\) failed/);
  assert.doesNotMatch(summary, /✓/);
});

test('Gate-Meldung: TypeScript- und node:test-Fehler auch ohne test:full', () => {
  const output = [
    'src/api/push.ts(23,5): error TS2322: Type string is not assignable to type number.',
    'not ok 3 - Logout löscht das eigene Abo',
  ].join('\n');
  assert.equal(
    gateFailureSummary(output),
    'src/api/push.ts(23,5): error TS2322: Type string is not assignable to type number. | not ok 3 - Logout löscht das eigene Abo',
  );
});

test('Gate-Meldung ohne erkennbaren Befund: wie bisher das Ende der Ausgabe', () => {
  const output = `${'x'.repeat(1000)}\nProzess abgebrochen`;
  assert.equal(gateFailureSummary(output), output.slice(-600));
});
