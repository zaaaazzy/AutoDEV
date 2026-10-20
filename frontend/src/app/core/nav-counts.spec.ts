import assert from 'node:assert/strict';
import { test } from 'node:test';
import { navCount, type NavCountSource } from './nav-counts.js';
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
