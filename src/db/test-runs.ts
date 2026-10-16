import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { TEST_RUN_STATUS } from '../core/status.js';

export async function createTestRun(
  pool: Pool,
  run: {
    projectSlug: string;
    trigger: string;
    branch: string | null;
    commitSha: string | null;
  },
): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO test_runs (id, project_slug, status, trigger, branch, commit_sha)
     VALUES ($1, $2, '${TEST_RUN_STATUS.running}', $3, $4, $5)`,
    [id, run.projectSlug, run.trigger, run.branch, run.commitSha],
  );
  return id;
}

export async function createTestRunStep(
  pool: Pool,
  step: {
    runId: string;
    position: number;
    command: string;
    output: string;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO test_run_steps (run_id, position, command, status, output)
     VALUES ($1, $2, $3, '${TEST_RUN_STATUS.running}', $4)`,
    [step.runId, step.position, step.command, step.output],
  );
}

export async function finishTestRunStep(
  pool: Pool,
  step: { runId: string; position: number; exitCode: number; durationMs: number; output: string },
): Promise<void> {
  await pool.query(
    `UPDATE test_run_steps
        SET status = $3, exit_code = $4, duration_ms = $5, output = $6
      WHERE run_id = $1 AND position = $2`,
    [
      step.runId,
      step.position,
      step.exitCode === 0 ? TEST_RUN_STATUS.passed : TEST_RUN_STATUS.failed,
      step.exitCode,
      step.durationMs,
      step.output,
    ],
  );
}

export async function finishTestRun(pool: Pool, runId: string, passed: boolean): Promise<void> {
  await pool.query(
    `UPDATE test_runs
        SET status = $2, completed_at = NOW()
      WHERE id = $1`,
    [runId, passed ? TEST_RUN_STATUS.passed : TEST_RUN_STATUS.failed],
  );
}
