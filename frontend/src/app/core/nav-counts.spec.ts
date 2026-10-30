import assert from 'node:assert/strict';
import { test } from 'node:test';
import { navCount, sprintHealthOf, sprintStateOf, type NavCountSource } from './nav-counts.js';
import { NAVIGATION } from './navigation.js';

const source: NavCountSource = { openBugs: 3, openIdeas: 5, attention: 2, runningAgents: 1 };

test('Bubbles nur für Bugs, offene Ideen, Aktionen und laufende Agents', () => {
  assert.equal(navCount('bugs', source), 3);
  assert.equal(navCount('ideation', source), 5);
  assert.equal(navCount('actions', source), 2);
  assert.equal(navCount('agents', source), 1);
  const withBubble = NAVIGATION.filter((item) => navCount(item.id, source) > 0).map((item) => item.id);
  assert.deepEqual(withBubble.sort(), ['actions', 'agents', 'bugs', 'ideation']);
});

test('Dokumentation, Testläufe, Aufträge, Sprints und Dashboard bleiben ohne Zahl', () => {
  for (const section of ['docs', 'runs', 'development', 'sprints', 'dashboard', 'stats', 'settings'] as const) {
    assert.equal(navCount(section, source), 0, section);
  }
});

test('Keine laufenden Agents: keine Bubble, auch wenn Agents angelegt sind', () => {
  assert.equal(navCount('agents', { ...source, runningAgents: 0 }), 0);
});

/** Pill und Handy-Chip so, wie die Kopfzeile sie aus beiden Funktionen zusammensetzt. */
function chip(input: { workerDown?: boolean; paused?: boolean; failed?: boolean; finished?: boolean; busy?: boolean }) {
  const health = sprintHealthOf({ workerDown: false, paused: false, failed: false, ...input });
  const state = sprintStateOf({ finished: false, busy: true, ...input, tone: health.tone });
  return { ...health, state };
}

test('Pausierter Sprint: „Sprint pausiert“ und kein ▶, auch wenn noch ein Agent fertig arbeitet', () => {
  const paused = chip({ paused: true, busy: true });
  assert.deepEqual(paused, { tone: 'paused', text: 'Sprint pausiert', state: 'paused' });
  assert.ok(!paused.text.includes('läuft'));
  assert.ok(!paused.text.includes('▶'));
});

test('Pausierter Sprint mit Fehlern bleibt pausiert', () => {
  assert.equal(chip({ paused: true, failed: true }).state, 'paused');
  assert.equal(chip({ paused: true, failed: true }).text, 'Sprint pausiert');
});

test('Pausiert und Worker offline: gestoppt hat Vorrang', () => {
  assert.deepEqual(chip({ paused: true, workerDown: true }), {
    tone: 'stopped',
    text: 'Sprint gestoppt: Worker offline',
    state: 'stopped',
  });
});

test('Pausiert und alles erledigt: Haken statt Pause', () => {
  assert.equal(chip({ paused: true, finished: true }).state, 'done');
});

test('Nach „Fortsetzen“ läuft der Sprint wieder', () => {
  assert.deepEqual(chip({ paused: false, busy: true }), { tone: 'ok', text: 'Sprint läuft', state: 'running' });
  assert.equal(chip({ paused: false, busy: false }).state, 'idle');
  assert.deepEqual(chip({ paused: false, failed: true }), {
    tone: 'warn',
    text: 'Sprint läuft mit Fehlern',
    state: 'warn',
  });
});
