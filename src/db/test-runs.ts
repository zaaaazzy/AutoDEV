import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import type { Pool } from 'pg';
import { TEST_RUN_STATUS } from '../core/status.js';
import type { TestCaseResult, TestCategory } from '../core/test-results.js';

/** Größte gespeicherte Datei (Video) und wie viele Läufe je Projekt ihre Screenshots und Videos behalten. */
const MAX_MEDIA_BYTES = 50 * 1024 * 1024;
const RUNS_WITH_MEDIA = 5;

export async function createTestRun(
  pool: Pool,
  run: {
    projectSlug: string;
    trigger: string;
    branch: string | null;
    commitSha: string | null;
    platform?: string;
  },
): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO test_runs (id, project_slug, status, trigger, branch, commit_sha, platform)
     VALUES ($1, $2, '${TEST_RUN_STATUS.running}', $3, $4, $5, $6)`,
    [id, run.projectSlug, run.trigger, run.branch, run.commitSha, run.platform ?? process.platform],
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
    category?: TestCategory | null;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO test_run_steps (run_id, position, command, status, output, category)
     VALUES ($1, $2, $3, '${TEST_RUN_STATUS.running}', $4, $5)`,
    [step.runId, step.position, step.command, step.output, step.category ?? null],
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

/**
 * Speichert Einzeltests eines Laufs samt Screenshots und Videos (Dateien werden von der Platte gelesen) und
 * löscht die Medien älterer Läufe des Projekts, damit die Datenbank nicht unbegrenzt wächst.
 */
export async function saveTestCases(pool: Pool, runId: string, cases: TestCaseResult[]): Promise<number> {
  let media = 0;
  const next = await pool.query<{ position: number }>(
    'SELECT COALESCE(max(position) + 1, 0)::int AS position FROM test_cases WHERE run_id = $1',
    [runId],
  );
  const offset = next.rows[0]?.position ?? 0;
  for (const [index, testCase] of cases.entries()) {
    const position = offset + index;
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO test_cases (run_id, position, category, title, file, device, status, duration_ms, errors)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
       RETURNING id`,
      [
        runId,
        position,
        testCase.category,
        testCase.title.slice(0, 500),
        testCase.file,
        testCase.device,
        testCase.status,
        testCase.durationMs,
        JSON.stringify(testCase.errors),
      ],
    );
    for (const file of testCase.media) {
      const size = (await stat(file.path).catch(() => null))?.size ?? 0;
      if (!size || size > MAX_MEDIA_BYTES) continue;
      await pool.query(
        `INSERT INTO test_media (run_id, case_id, name, mime, size, data) VALUES ($1, $2, $3, $4, $5, $6)`,
        [runId, inserted.rows[0]!.id, file.name.slice(0, 200), file.mime, size, await readFile(file.path)],
      );
      media += 1;
    }
  }
  await pool.query(
    `DELETE FROM test_media
      WHERE run_id IN (
        SELECT id FROM test_runs
         WHERE project_slug = (SELECT project_slug FROM test_runs WHERE id = $1)
         ORDER BY started_at DESC
        OFFSET $2)`,
    [runId, RUNS_WITH_MEDIA],
  );
  return media;
}

/** Testbericht (Markdown) zum Lauf speichern; er erscheint in der Dokumentation unter „Testberichte“. */
export async function saveTestReport(pool: Pool, runId: string, report: string): Promise<void> {
  await pool.query('UPDATE test_runs SET report = $2 WHERE id = $1', [runId, report.slice(0, 200_000)]);
}
