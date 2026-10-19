import assert from 'node:assert/strict';
import test from 'node:test';
import { describeEvent, waitingFor, type WaitingState } from './timeline.js';

const base: WaitingState = {
  status: 'blocked',
  kind: 'feature',
  autoRun: false,
  actionTodo: null,
  analysisStatus: null,
  sprintStatus: 'active',
  runningAgent: null,
  openQuestion: false,
  bugfix: null,
};

test('says what a blocked order is waiting for, most specific first', () => {
  assert.equal(waitingFor({ ...base, openQuestion: true, actionTodo: 'x' }).label, 'Wartet auf deine Antwort');
  assert.equal(waitingFor({ ...base, analysisStatus: 'running' }).label, 'Wartet auf die Problemanalyse');
  assert.match(waitingFor({ ...base, bugfix: { title: 'Fix', status: 'planned' } }).label, /Bugfix „Fix“/);
  assert.equal(
    waitingFor({ ...base, bugfix: { title: 'Fix', status: 'done' } }).label,
    'Wartet auf „Erneut versuchen“',
  );
  assert.equal(waitingFor({ ...base, actionTodo: 'Laufwerk anschliessen' }).tone, 'you');
});

test('planned orders wait for the sprint or a free worker slot', () => {
  assert.equal(
    waitingFor({ ...base, status: 'planned', sprintStatus: 'planned' }).label,
    'Wartet auf den Start des Sprints',
  );
  assert.equal(waitingFor({ ...base, status: 'planned', sprintStatus: null, autoRun: true }).tone, 'wait');
  assert.equal(waitingFor({ ...base, status: 'in_progress', runningAgent: 'Tester' }).label, 'Läuft: Tester');
});

test('status events become readable entries', () => {
  const entry = describeEvent({ at: new Date('2026-10-19T10:00:00Z'), kind: 'status', detail: 'in_progress>blocked' });
  assert.equal(entry.title, 'In Arbeit → Blockiert');
  assert.equal(entry.state, 'failed');
  assert.equal(
    describeEvent({ at: new Date(), kind: 'analysis', detail: 'requested' }).title,
    'Problemanalyse angefordert',
  );
});
