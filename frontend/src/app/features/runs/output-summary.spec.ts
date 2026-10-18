import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeOutput } from './output-summary.js';

test('Build: Bundle-Tabelle, Gesamtgröße und doppelte Warnungen mit Fundstelle zusammengefasst', () => {
  const output = [
    'Initial chunk files   | Names         |  Raw size | Estimated transfer size',
    'main-QU3HVRK2.js      | main          | 729.00 kB |               174.69 kB',
    'styles-X.css          | styles        | 140.07 kB |                29.86 kB',
    '',
    '                      | Initial total | 869.07 kB |               204.55 kB',
    '',
    'Application bundle generation complete. [4.776 seconds] - 2026-10-18T15:43:33.168Z',
    '',
    "▲ [WARNING] NG8102: The left side of this nullish coalescing operation does not include 'null' [plugin angular-compiler]",
    '',
    '    /Volumes/External/DevLog/frontend/src/app/x.component.html:32:19:',
    '      32 │  [ngModel]="a ?? b"',
    "▲ [WARNING] NG8102: The left side of this nullish coalescing operation does not include 'null' [plugin angular-compiler]",
    '',
    '    /Volumes/External/DevLog/frontend/src/app/x.component.html:32:19:',
  ].join('\n');
  const summary = summarizeOutput('npm run build', output, 'passed');
  assert.equal(summary.headline, 'Build erstellt · 2 Warnungen');
  assert.deepEqual(summary.table?.headers, ['Datei', 'Names', 'Raw size', 'Estimated transfer size']);
  assert.equal(summary.table?.rows.length, 3);
  assert.deepEqual(summary.facts, [
    { label: 'Gesamtgröße', value: '869.07 kB (übertragen 204.55 kB)' },
    { label: 'Build', value: '4.8 s' },
  ]);
  assert.deepEqual(summary.issues, [
    {
      level: 'warning',
      code: 'NG8102',
      message: "The left side of this nullish coalescing operation does not include 'null'",
      location: 'frontend/src/app/x.component.html:32:19',
      count: 2,
    },
  ]);
});

test('Lint: Meldungen je Regel gezählt, Fehler vor Warnungen', () => {
  const output = [
    '/Volumes/External/DevLog/src/a.ts',
    '   5:18  warning  Forbidden non-null assertion  @typescript-eslint/no-non-null-assertion',
    '   9:2   error    Expected === and instead saw ==  eqeqeq',
    '/Volumes/External/DevLog/src/b.ts',
    '  12:3   warning  Forbidden non-null assertion  @typescript-eslint/no-non-null-assertion',
    '',
    '✖ 3 problems (1 error, 2 warnings)',
  ].join('\n');
  const summary = summarizeOutput('npm run lint', output, 'failed');
  assert.equal(summary.headline, '1 Lint-Fehler · 2 Warnungen');
  assert.deepEqual(
    summary.issues.map((issue) => [issue.level, issue.code, issue.location, issue.count]),
    [
      ['error', 'eqeqeq', 'src/a.ts:9', 1],
      ['warning', '@typescript-eslint/no-non-null-assertion', 'src/a.ts:5', 2],
    ],
  );
});

test('Typen, Formatierung, Unit-Tests und Playwright', () => {
  assert.equal(
    summarizeOutput('npm run typecheck', "src/x.ts(4,7): error TS2322: Type 'string' is not assignable.", 'failed')
      .headline,
    '1 Typfehler',
  );
  assert.equal(summarizeOutput('npm run typecheck', '> tsc --noEmit', 'passed').headline, 'keine Typfehler');
  assert.equal(
    summarizeOutput('npm run format:check', '[warn] src/a.ts\n[warn] Code style issues found', 'failed').headline,
    '1 Dateien nicht formatiert',
  );
  const unit = summarizeOutput('npm test', 'not ok 3 - rechnet\n# pass 10\n# fail 1\n# duration_ms 1200', 'failed');
  assert.equal(unit.headline, '1 Tests fehlgeschlagen, 10 bestanden');
  assert.deepEqual(unit.issues[0]?.message, 'rechnet');
  const e2e = summarizeOutput(
    'npx playwright test',
    '  ✘   2 [desktop] › e2e/app.spec.ts:60:1 › Alle Bereiche laden (1.2s)\n  1 failed\n  33 passed (36.0s)',
    'failed',
  );
  assert.equal(e2e.headline, '1 Tests fehlgeschlagen, 33 bestanden');
  assert.deepEqual(
    [e2e.issues[0]?.code, e2e.issues[0]?.message, e2e.issues[0]?.location],
    ['desktop', 'Alle Bereiche laden', 'e2e/app.spec.ts'],
  );
});
