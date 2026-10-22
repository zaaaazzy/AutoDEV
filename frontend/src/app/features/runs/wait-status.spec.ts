import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runningStep, typicalRunMs, waitStatus } from './wait-status.js';

const run = (trigger: string, minutes: number) => ({
  trigger,
  startedAt: '2026-10-21T10:00:00.000Z',
  completedAt: new Date(Date.parse('2026-10-21T10:00:00.000Z') + minutes * 60_000).toISOString(),
});
const live = (trigger: string, elapsedMinutes: number) => ({
  trigger,
  startedAt: '2026-10-21T12:00:00.000Z',
  now: new Date(Date.parse('2026-10-21T12:00:00.000Z') + elapsedMinutes * 60_000).toISOString(),
  steps: [],
});

test('übliche Dauer: Median der Läufe mit demselben Auslöser, sonst aller Läufe', () => {
  const history = [run('gate', 10), run('gate', 6), run('gate', 8), run('manual', 2)];
  assert.equal(typicalRunMs(history, 'gate'), 8 * 60_000);
  assert.equal(typicalRunMs(history, 'schedule'), 8 * 60_000);
  assert.equal(typicalRunMs([{ ...run('gate', 5), completedAt: null }], 'gate'), null);
});

test('laufender Test: Restzeit in Minuten und Fortschritt aus der üblichen Dauer', () => {
  const status = waitStatus(live('manual', 3), null, [run('manual', 8)]);
  assert.deepEqual(status, { label: 'Test läuft', hint: 'bitte warte noch etwa 5 Min.', percent: 38 });
});

test('Test-Gate der Sprint-Sicherung: eigener Text, Balken bleibt unter 100 % solange er läuft', () => {
  const status = waitStatus(live('gate', 12), { gitSync: 'running' }, [run('gate', 8)]);
  assert.equal(status?.label, 'Test-Gate läuft, danach Push');
  assert.equal(status?.hint, 'dauert länger als üblich – gleich fertig');
  assert.equal(status?.percent, 97);
});

test('ohne frühere Läufe: unbestimmter Fortschritt', () => {
  assert.equal(waitStatus(live('manual', 1), null, [])?.percent, null);
});

test('ausstehender Push ohne laufenden Test; sonst nichts anzuzeigen', () => {
  assert.equal(waitStatus(null, { gitSync: 'pending' }, [])?.label, 'Push steht an');
  assert.equal(waitStatus(null, { gitSync: 'running' }, [])?.label, 'Merge und Push laufen');
  assert.equal(waitStatus(null, { gitSync: 'done' }, []), null);
  assert.equal(waitStatus(null, null, []), null);
});

test('laufender Testschritt: Nummer, Name und Fortschritt', () => {
  const steps = [
    { position: 0, command: 'npm run lint', status: 'passed', progress: null },
    { position: 1, command: 'npm test', status: 'running', progress: '120 von 980 Tests' },
    { position: 2, command: 'npm run test:e2e', status: 'running', progress: null },
  ] as Parameters<typeof runningStep>[0];
  assert.equal(runningStep(steps), 'Schritt 2 von 3 · Unit-Tests (inkl. UI-Build) · 120 von 980 Tests');
  assert.equal(runningStep([]), '');
  const status = waitStatus({ ...live('manual', 3), steps }, null, [run('manual', 8)]);
  assert.equal(status?.detail, 'Schritt 2 von 3 · Unit-Tests (inkl. UI-Build) · 120 von 980 Tests');
});

test('Pull-Request-Modus: CI-Prüfung läuft, danach Merge; rote CI zeigt keinen Ladebalken', () => {
  const sprint = { gitSync: 'done', status: 'review', prUrl: 'https://github.com/x/y/pull/9' } as const;
  assert.equal(waitStatus(null, { ...sprint, ciStatus: 'pending' }, [])?.label, 'CI-Prüfung auf GitHub läuft');
  assert.equal(waitStatus(null, { ...sprint, ciStatus: 'success' }, [])?.label, 'Merge nach main');
  assert.equal(waitStatus(null, { ...sprint, ciStatus: 'failure' }, []), null);
  assert.equal(waitStatus(null, { ...sprint, status: 'active', ciStatus: 'pending' }, []), null);
});
