import assert from 'node:assert/strict';
import test from 'node:test';
import { checkChromium } from '../setup/setup-jobs.js';
import { selectWorkflowAgents } from './runner-steps.js';
import type { WorkflowAgent, WorkItem } from './runner-types.js';

const agent = (role: string, position: number): WorkflowAgent => ({
  id: `agent-${role}`,
  name: role,
  role,
  phase: role === 'developer' ? 'while_task' : 'after_task',
  position,
  instructions: '',
  command: null,
});
const AGENTS = [agent('developer', 1), agent('tester', 1), agent('visual_tester', 2), agent('reviewer', 3)];
const item = (category: string | null, agentId: string | null = null): WorkItem => ({
  id: 'order',
  projectSlug: 'alpha',
  title: 'Auftrag',
  description: '',
  category,
  agentId,
});

test('Visueller Tester läuft nach dem Tester, nur bei Frontend- und Fullstack-Aufträgen', () => {
  const roles = (selected: WorkflowAgent[]) => selected.map((entry) => entry.role);
  assert.deepEqual(roles(selectWorkflowAgents(AGENTS, item('frontend'))), [
    'developer',
    'tester',
    'visual_tester',
    'reviewer',
  ]);
  assert.ok(roles(selectWorkflowAgents(AGENTS, item('fullstack'))).includes('visual_tester'));
  for (const category of ['backend', 'infrastructure', 'docs', null]) {
    assert.ok(!roles(selectWorkflowAgents(AGENTS, item(category))).includes('visual_tester'), String(category));
  }
  // Einzeln gestartet läuft er auch bei anderen Aufträgen (und überspringt dann selbst ohne Fehler).
  assert.deepEqual(roles(selectWorkflowAgents(AGENTS, item('backend', 'agent-visual_tester'))), ['visual_tester']);
});

test('Einrichtung: Chromium vorhanden, fehlend oder Playwright nicht installiert', async () => {
  const present = await checkChromium(async () => ({ chromium: { executablePath: () => process.execPath } }));
  assert.equal(present.installed, true);
  assert.match(present.command, /playwright install chromium/);
  const missing = await checkChromium(async () => ({ chromium: { executablePath: () => '/gibt/es/nicht' } }));
  assert.equal(missing.installed, false);
  const noPackage = await checkChromium(() => Promise.reject(new Error('Cannot find package')));
  assert.deepEqual([noPackage.installed, noPackage.playwright], [false, false]);
});
