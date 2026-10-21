import assert from 'node:assert/strict';
import { test } from 'node:test';
import { liveStepMs, liveStepName } from './test-run-live.js';

test('Live-Anzeige: Schrittnamen aus den Befehlen des Komplettlaufs', () => {
  assert.equal(liveStepName('npm run lint'), 'Lint');
  assert.equal(liveStepName('npm run format:check'), 'Formatierung');
  assert.equal(liveStepName('npm run typecheck'), 'Typprüfung');
  assert.equal(liveStepName('npm test'), 'Unit-Tests (inkl. UI-Build)');
  assert.equal(liveStepName('npx playwright test -c e2e/playwright.config.ts --reporter=list,json'), 'E2E-Tests');
  assert.equal(liveStepName('npx playwright test -c e2e/full.config.ts'), 'Oberflächentest');
});

test('Live-Anzeige: laufender Schritt zählt ab seinem Start, fertiger zeigt seine Dauer', () => {
  const step = {
    position: 0,
    command: 'npm test',
    status: 'running' as const,
    category: null,
    progress: null,
    output: '',
  };
  assert.equal(
    liveStepMs({ ...step, durationMs: null, startedAt: '2026-10-21T20:00:00Z' }, '2026-10-21T20:01:30Z'),
    90_000,
  );
  assert.equal(
    liveStepMs({ ...step, durationMs: 4_000, startedAt: '2026-10-21T20:00:00Z' }, '2026-10-21T20:05:00Z'),
    4_000,
  );
});
