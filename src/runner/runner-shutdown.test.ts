import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';
import type { CommandExecutor } from '../core/command.js';
import { beginShutdown } from '../core/shutdown.js';
import { runWorkItem, type WorkflowAgent } from './runner.js';

// Eigene Datei: beginShutdown gilt für den ganzen Prozess (der Test-Runner startet je Datei einen eigenen).
test('Worker beendet während des Schritts: Schritt unterbrochen, Tokens und Kosten bleiben am Schritt', async () => {
  const queries: { sql: string; values: unknown[] }[] = [];
  const pool = {
    query: async (sql: string, values: unknown[] = []) => {
      queries.push({ sql, values });
      if (sql.includes('INSERT INTO agent_runs')) return { rows: [{ id: 'run-1' }] };
      return { rows: [{ id: 'step-row' }] };
    },
  } as unknown as Pool;
  const execute: CommandExecutor = async (command) => {
    if (command[0] !== 'dev') return { exitCode: 0, durationMs: 1, output: '' };
    beginShutdown();
    return { exitCode: 1, durationMs: 1, output: 'Process ended by SIGTERM', tokens: 4321, costUsd: 1.75 };
  };
  const dev: WorkflowAgent = {
    id: 'dev-id',
    name: 'dev',
    role: 'custom',
    phase: 'while_task',
    position: 1,
    instructions: 'dev macht etwas',
    command: ['dev'],
  };
  const item = { id: 'item-1', projectSlug: 'mainty', title: 'Sprints', description: 'Bauen' };
  await runWorkItem(pool, item, [dev], { cwd: '/repo', timeoutMs: 1000, execute });
  const step = queries.find((query) => query.sql.includes('interrupted = TRUE') && query.sql.includes('WHERE id = $1'));
  assert.ok(step, 'Schritt als unterbrochen markiert');
  assert.match(String(step.values[3]), /Der Worker wurde beendet/);
  assert.equal(step.values[4], 4321);
  assert.equal(step.values[5], 1.75);
  assert.ok(!queries.some((query) => query.sql.includes('INSERT INTO bugs')), 'kein Bug-Bericht');
});
