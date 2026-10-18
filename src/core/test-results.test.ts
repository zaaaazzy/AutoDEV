import assert from 'node:assert/strict';
import test from 'node:test';
import { categoryOfCommand, parsePlaywrightCases, parseTapCases, playwrightHeadline } from './test-results.js';

test('Kategorie ergibt sich aus dem Befehl', () => {
  assert.equal(categoryOfCommand('npm run lint'), 'quality');
  assert.equal(categoryOfCommand('npm run build'), 'quality');
  assert.equal(categoryOfCommand('npm test'), 'unit');
  assert.equal(categoryOfCommand('npx playwright test -c e2e/playwright.config.ts'), 'e2e');
  assert.equal(categoryOfCommand('npx playwright test -c e2e/full.config.ts'), 'user');
});

test('TAP: Tests der obersten Ebene mit Status, Dauer und Fehlermeldung', () => {
  const output = [
    'TAP version 13',
    '# Subtest: rechnet richtig',
    'ok 1 - rechnet richtig',
    '  ---',
    '  duration_ms: 1.6',
    '  ...',
    '# Subtest: meldet Fehler',
    '    ok 1 - Untertest zählt nicht extra',
    'not ok 2 - meldet Fehler',
    '  ---',
    '  duration_ms: 12.4',
    "  failureType: 'testCodeFailure'",
    '  error: |-',
    '    Expected values to be strictly equal:',
    '  ...',
    'ok 3 - später # SKIP noch nicht fertig',
    '# pass 1',
  ].join('\n');
  const cases = parseTapCases(output);
  assert.deepEqual(
    cases.map(({ title, status, durationMs }) => ({ title, status, durationMs })),
    [
      { title: 'rechnet richtig', status: 'passed', durationMs: 2 },
      { title: 'meldet Fehler', status: 'failed', durationMs: 12 },
      { title: 'später', status: 'skipped', durationMs: null },
    ],
  );
  assert.deepEqual(cases[1]!.errors, ['Expected values to be strictly equal:']);
  assert.ok(cases.every((testCase) => testCase.category === 'unit'));
});

test('Playwright: je Gerät ein Eintrag, Befunde gekürzt, Screenshots und Video übernommen', () => {
  const cases = parsePlaywrightCases(
    {
      suites: [
        {
          suites: [
            {
              specs: [
                {
                  title: 'Alle Seiten laden',
                  file: 'full-ui.check.ts',
                  tests: [
                    {
                      projectName: 'desktop',
                      status: 'unexpected',
                      results: [
                        {
                          duration: 2100.4,
                          errors: [
                            { message: 'Error: Formular erscheint im Bild\n\nexpect(locator).toBeInViewport() failed' },
                            { message: 'TimeoutError: locator.click: Timeout 15000ms exceeded.\n  - waiting for x' },
                          ],
                          attachments: [
                            { name: 'dashboard', contentType: 'image/png', path: '/tmp/a.png' },
                            { name: 'video', contentType: 'video/webm', path: '/tmp/v.webm' },
                            { name: 'trace', contentType: 'application/zip', path: '/tmp/t.zip' },
                            { name: 'ohne Datei', contentType: 'image/png' },
                          ],
                        },
                      ],
                    },
                    { projectName: 'handy', status: 'skipped', results: [{ duration: 0 }] },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
    'user',
  );
  assert.equal(cases.length, 2);
  assert.deepEqual(
    { ...cases[0], media: cases[0]!.media.map((file) => `${file.name}:${file.mime}`) },
    {
      category: 'user',
      title: 'Alle Seiten laden',
      file: 'full-ui.check.ts',
      device: 'desktop',
      status: 'failed',
      durationMs: 2100,
      errors: ['Formular erscheint im Bild', 'TimeoutError: locator.click: Timeout 15000ms exceeded. – waiting for x'],
      media: ['dashboard:image/png', 'Video:video/webm'],
    },
  );
  assert.equal(cases[1]!.status, 'skipped');
});

test('Kurzfassung allgemeiner Meldungen nennt den Locator', () => {
  assert.equal(
    playwrightHeadline("Error: expect(locator).toBeVisible() failed\n\nLocator: getByText('Hallo')\nExpected: visible"),
    "expect(locator).toBeVisible() failed – Locator: getByText('Hallo')",
  );
});
