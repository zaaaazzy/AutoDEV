import assert from 'node:assert/strict';
import { test } from 'node:test';
import { splitTestSteps, summarizeTestOutput, type TestStep } from './test-output.js';

test('Testausgabe wird in Befehle mit Kurzfazit zerlegt, Rohzeilen verschwinden aus dem Text', () => {
  const parts = splitTestSteps(
    [
      'Bericht des Testers.',
      '## Testlauf (Projekttests)',
      'Testlauf b4018d7f-3a2d-44fd-8575-5973b5939cd9',
      '',
      '$ npm test --workspace=backend → passed 68 - should handle',
      '# Subtest: rate limiter',
      'ok 69 - rate limiter',
      '# tests 69',
      '# pass 69',
      '# fail 0',
      '',
      '$ docker compose build frontend → passed #21 naming to docker.io/library/mainty-frontend:latest done',
      'Image mainty-frontend Built',
      '## Abnahme nicht bestanden',
      '- DoD 1 offen',
    ].join('\n'),
  );
  const steps = parts.filter((part): part is TestStep => typeof part !== 'string');
  assert.deepEqual(
    steps.map((step) => [step.command, step.status, step.summary]),
    [
      ['npm test --workspace=backend', 'passed', '69 Tests · alle bestanden'],
      ['docker compose build frontend', 'passed', 'Image mainty-frontend gebaut'],
    ],
  );
  const text = parts.filter((part) => typeof part === 'string').join('\n');
  assert.doesNotMatch(text, /Subtest|Testlauf b4018/);
  assert.match(text, /## Abnahme nicht bestanden/);
});

test('Kurzfazit für Vitest/Jest und Fehler', () => {
  assert.equal(summarizeTestOutput('Tests  2 failed | 134 passed (136)', 'failed'), '136 Tests · 2 fehlgeschlagen');
  assert.equal(
    summarizeTestOutput('Tests:       1 failed, 68 passed, 69 total', 'failed'),
    '69 Tests · 1 fehlgeschlagen',
  );
  assert.equal(summarizeTestOutput('tsc ok', 'passed'), 'erfolgreich');
  assert.equal(summarizeTestOutput('src/a.ts(3,1): error TS2304: x\nmore', 'failed'), 'src/a.ts(3,1): error TS2304: x');
});
