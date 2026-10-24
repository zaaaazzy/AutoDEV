import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RunStep } from '../core/models.js';
import { agentEnds, type WorkflowRow } from './workflow.js';

const row = (name: string, status: string | null, output = ''): WorkflowRow => ({
  key: name,
  name,
  step: status ? ({ runId: 'r', position: 0, command: '', status, output } as RunStep) : undefined,
});

test('Agents: Endstatus je Agent – bestanden, gescheitert, abgebrochen, unterbrochen, läuft; ohne Schritt nichts', () => {
  const ends = agentEnds([
    row('Entwickler', 'passed'),
    row('Tester', 'failed', 'Zwei Tests rot'),
    row('Reviewer', 'failed', 'Vom Benutzer abgebrochen.'),
    row('Dokumentierer', 'failed', 'Ausgabe\nUnterbrochen: Der Worker wurde beendet.'),
    row('Handbuch-Autor', 'running'),
    row('Bug-Wächter', null),
  ]);
  assert.deepEqual(
    ends.map((end) => `${end.name} ${end.icon} ${end.label}`),
    [
      'Entwickler ✓ bestanden',
      'Tester ✗ gescheitert',
      'Reviewer ⏹ abgebrochen',
      'Dokumentierer ⏸ unterbrochen',
      'Handbuch-Autor ⏳ läuft',
    ],
  );
});
