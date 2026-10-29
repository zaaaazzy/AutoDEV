import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentPhase, WorkflowStep } from '../../core/models.js';
import { applyOrders, moveStep, stepsInPhase } from './workflow-order.js';

function step(id: string, phase: AgentPhase, position: number, enabled = true): WorkflowStep {
  return { id, phase, position, agentId: `agent-${id}`, instructions: '', enabled };
}

// Bewusst nicht nach Position sortiert: Die Berechnung muss selbst sortieren.
const STEPS = [
  step('c', 'while_task', 3),
  step('a', 'while_task', 1),
  step('b', 'while_task', 2),
  step('x', 'after_task', 1),
  step('y', 'after_task', 2),
];

test('Innerhalb einer Phase: nach unten und nach oben ziehen', () => {
  // Einfügestellen zählen den gezogenen Schritt mit: 3 = ans Ende hinter „c“.
  assert.deepEqual(moveStep(STEPS, 'a', 'while_task', 3), [{ phase: 'while_task', ids: ['b', 'c', 'a'] }]);
  assert.deepEqual(moveStep(STEPS, 'a', 'while_task', 2), [{ phase: 'while_task', ids: ['b', 'a', 'c'] }]);
  assert.deepEqual(moveStep(STEPS, 'c', 'while_task', 0), [{ phase: 'while_task', ids: ['c', 'a', 'b'] }]);
});

test('Ablegen an der eigenen Stelle ändert nichts und sendet nichts', () => {
  assert.deepEqual(moveStep(STEPS, 'b', 'while_task', 1), []);
  assert.deepEqual(moveStep(STEPS, 'b', 'while_task', 2), []);
  assert.deepEqual(moveStep(STEPS, 'fehlt', 'while_task', 0), []);
});

test('In eine andere Phase: Zielphase zuerst, dann die Quellphase ohne den Schritt', () => {
  assert.deepEqual(moveStep(STEPS, 'b', 'after_task', 1), [
    { phase: 'after_task', ids: ['x', 'b', 'y'] },
    { phase: 'while_task', ids: ['a', 'c'] },
  ]);
});

test('In eine leere Phase und mit zu großer Einfügestelle ans Ende', () => {
  assert.deepEqual(moveStep(STEPS, 'a', 'on_done', 0), [
    { phase: 'on_done', ids: ['a'] },
    { phase: 'while_task', ids: ['b', 'c'] },
  ]);
  assert.deepEqual(moveStep(STEPS, 'a', 'after_task', Number.MAX_SAFE_INTEGER)[0], {
    phase: 'after_task',
    ids: ['x', 'y', 'a'],
  });
});

test('Nach dem Verschieben sind beide Phasen lückenlos ab 1 nummeriert, der Status bleibt', () => {
  const paused = STEPS.map((entry) => (entry.id === 'a' ? { ...entry, enabled: false } : entry));
  const moved = applyOrders(paused, moveStep(paused, 'a', 'after_task', 0));
  const positions = (phase: AgentPhase) => stepsInPhase(moved, phase).map((entry) => [entry.id, entry.position]);
  assert.deepEqual(positions('while_task'), [
    ['b', 1],
    ['c', 2],
  ]);
  assert.deepEqual(positions('after_task'), [
    ['a', 1],
    ['x', 2],
    ['y', 3],
  ]);
  assert.equal(moved.find((entry) => entry.id === 'a')?.enabled, false, 'pausiert bleibt pausiert');
});
