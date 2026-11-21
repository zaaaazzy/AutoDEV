import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';
import { resumePosition } from './runner-resume.js';
import type { StepSummary, WorkflowAgent } from './runner-types.js';

const agent = (name: string, phase: string, role = 'custom', stepId?: string): WorkflowAgent => ({
  id: `${name}-id`,
  name,
  role,
  phase,
  position: 1,
  instructions: '',
  command: null,
  ...(stepId ? { stepId } : {}),
});

const developer = agent('dev', 'while_task', 'developer');
const tester = agent('tester', 'after_task', 'tester');
const reviewer = agent('reviewer', 'after_task', 'reviewer');
const documenter = agent('doc', 'after_task', 'documenter');
const workflow = [developer, tester, reviewer, documenter];

interface Row {
  agent_id: string;
  workflow_step_id?: string | null;
  agent_name: string;
  phase: string;
  status: string;
  output: string;
  interrupted?: boolean;
}

const step = (who: WorkflowAgent, status: string, output: string, interrupted = false): Row => ({
  agent_id: who.id,
  workflow_step_id: who.stepId ?? null,
  agent_name: who.name,
  phase: who.phase,
  status,
  output,
  interrupted,
});

/** Frühere Läufe, jüngster zuerst (wie `ORDER BY started_at DESC`), je mit Status und Schritten. */
function poolWithRuns(runs: { id: string; status: string; steps: Row[] }[]) {
  const queries: { sql: string; values: unknown[] }[] = [];
  const pool = {
    query: async (sql: string, values: unknown[] = []) => {
      queries.push({ sql, values });
      if (sql.includes('FROM agent_runs WHERE development_id')) {
        return { rows: runs.map(({ id, status }) => ({ id, status })) };
      }
      if (sql.includes('FROM agent_run_steps WHERE run_id')) {
        return { rows: runs.find((run) => run.id === values[0])?.steps ?? [] };
      }
      return { rows: [] };
    },
  } as unknown as Pool;
  return { pool, queries };
}

async function resume(runs: { id: string; status: string; steps: Row[] }[], ordered = workflow) {
  const done: StepSummary[] = [];
  const position = await resumePosition(poolWithRuns(runs).pool, 'item', 'run-now', ordered, done);
  return { position, done: done.map((entry) => `${entry.agentName}:${entry.status}`) };
}

test('resumePosition: ein Lauf ohne Schritte (OrderBranchError) löscht den Fortschritt der Läufe davor nicht', async () => {
  // pianotrainer, 21.11.2026: Entwickler und Tester bestanden, Budget-Block, Freigabe, Reviewer bestanden, dann brach
  // der Lauf vor dem Dokumentierer ohne Schritt ab – der nächste Versuch begann wieder beim Entwickler.
  const result = await resume([
    { id: 'run-c', status: 'failed', steps: [] },
    { id: 'run-b', status: 'failed', steps: [step(reviewer, 'passed', 'freigegeben')] },
    { id: 'run-a', status: 'failed', steps: [step(developer, 'passed', 'gebaut'), step(tester, 'passed', 'grün')] },
  ]);
  assert.equal(result.position, 3, 'weiter beim Dokumentierer');
  assert.deepEqual(result.done, ['dev:passed', 'tester:passed', 'reviewer:passed']);
});

test('resumePosition: ein fortgesetzter Lauf beginnt mitten im Ablauf – seine Schritte zählen trotzdem richtig', async () => {
  // Lauf B startete beim Tester (Position 1) und speicherte nur Tester und Reviewer; ohne Zuordnung nach Schlüssel
  // stünde sein erster Schritt an Position 0 und passte nicht zum Entwickler.
  const result = await resume([
    { id: 'run-b', status: 'failed', steps: [step(tester, 'passed', 'grün'), step(reviewer, 'failed', 'halb', true)] },
    {
      id: 'run-a',
      status: 'failed',
      steps: [step(developer, 'passed', 'gebaut'), step(tester, 'failed', 'rot', true)],
    },
  ]);
  assert.equal(result.position, 2, 'der unterbrochene Reviewer setzt fort');
  assert.deepEqual(result.done, ['dev:passed', 'tester:passed']);
});

test('resumePosition: ein erfolgreicher Lauf ist ein echter Neustart – ältere Läufe zählen nicht mehr', async () => {
  const result = await resume([
    { id: 'run-b', status: 'passed', steps: workflow.map((who) => step(who, 'passed', 'ok')) },
    { id: 'run-a', status: 'failed', steps: [step(developer, 'passed', 'alt')] },
  ]);
  assert.deepEqual(result, { position: 0, done: [] });
});

test('resumePosition: ein gescheiterter späterer Schritt desselben Einsatzes setzt ihn zurück', async () => {
  // Der Dokumentierer bestand in Lauf A, scheiterte in Lauf B: Lauf B gilt, der Dokumentierer läuft erneut.
  const result = await resume([
    { id: 'run-b', status: 'failed', steps: [step(documenter, 'failed', 'leer')] },
    {
      id: 'run-a',
      status: 'failed',
      steps: [
        step(developer, 'passed', 'gebaut'),
        step(tester, 'passed', 'grün'),
        step(reviewer, 'passed', 'frei'),
        step(documenter, 'passed', 'doku'),
      ],
    },
  ]);
  assert.equal(result.position, 3);
  assert.deepEqual(result.done, ['dev:passed', 'tester:passed', 'reviewer:passed']);
});

test('resumePosition: Ablehnung des Testers in einem älteren Lauf geht als Rückmeldung an den Entwickler', async () => {
  const result = await resume([
    { id: 'run-b', status: 'failed', steps: [] },
    {
      id: 'run-a',
      status: 'failed',
      steps: [step(developer, 'passed', 'gebaut'), step(tester, 'failed', 'Test X rot')],
    },
  ]);
  assert.equal(result.position, 0);
  assert.deepEqual(result.done, ['tester:failed']);
});

test('resumePosition: Nachbesserung im Lauf – je Einsatz zählt der letzte Schritt, auch über Läufe hinweg', async () => {
  const result = await resume([
    {
      id: 'run-b',
      status: 'failed',
      steps: [step(developer, 'passed', 'drittes Mal'), step(tester, 'passed', 'grün')],
    },
    {
      id: 'run-a',
      status: 'failed',
      steps: [
        step(developer, 'passed', 'gebaut'),
        step(tester, 'failed', 'erste Rückmeldung'),
        step(developer, 'passed', 'nachgebessert'),
        step(tester, 'failed', 'zweite Rückmeldung'),
      ],
    },
  ]);
  assert.equal(result.position, 2, 'Reviewer ist dran');
  assert.deepEqual(result.done, ['dev:passed', 'tester:passed']);
});

test('resumePosition: Schritte von Beobachtern oder aus einem umgebauten Workflow bleiben aussen vor', async () => {
  const observer = agent('melder', 'on_rejected');
  const result = await resume([
    {
      id: 'run-a',
      status: 'failed',
      steps: [step(developer, 'passed', 'gebaut'), step(tester, 'failed', 'rot', true), step(observer, 'passed', 'x')],
    },
  ]);
  assert.equal(result.position, 1);
  assert.deepEqual(result.done, ['dev:passed']);
});

test('resumePosition: ohne frühere Läufe oder nur mit laufenden beginnt der Ablauf vorn', async () => {
  assert.deepEqual(await resume([]), { position: 0, done: [] });
  assert.deepEqual(await resume([{ id: 'run-x', status: 'running', steps: [step(developer, 'passed', 'x')] }]), {
    position: 0,
    done: [],
  });
});
