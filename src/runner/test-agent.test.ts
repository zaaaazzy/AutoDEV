import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';
import { parseTestAgentOptions, runTestAgent } from './test-agent.js';

test('parses project, working directory, and explicit argument-array commands', () => {
  const options = parseTestAgentOptions([
    '--project',
    'demo-project',
    '--cwd',
    '/tmp/demo-project',
    '--commands',
    '[["npm","run","lint"],["npm","test"]]',
  ]);
  assert.deepEqual(options, {
    project: 'demo-project',
    cwd: '/tmp/demo-project',
    commands: [
      ['npm', 'run', 'lint'],
      ['npm', 'test'],
    ],
  });
});

test('rejects invalid project slugs and shell command strings', () => {
  assert.throws(() => parseTestAgentOptions(['--project', '../private']));
  assert.throws(() => parseTestAgentOptions(['--commands', '"npm test"']));
  assert.throws(() => parseTestAgentOptions(['--commands', '[["npm","test"]]', '--unexpected']));
});

test('runs a command and persists a sanitized test run and result', async () => {
  let runId = '';
  const writes: { sql: string; values: unknown[] }[] = [];
  const previousSecret = process.env.DEV_LOG_TEST_SECRET;
  process.env.DEV_LOG_TEST_SECRET = 'do-not-log-this-secret';
  const pool = {
    query: async (sql: string, values: unknown[] = []) => {
      writes.push({ sql, values });
      if (sql.includes('INSERT INTO test_runs')) {
        runId = String(values[0]);
        return { rows: [{ id: runId }] };
      }
      return { rows: [] };
    },
  } as unknown as Pool;

  try {
    const recordedRunId = await runTestAgent(
      {
        project: 'test-project',
        cwd: process.cwd(),
        commands: [[process.execPath, '-e', 'console.log(process.env.DEV_LOG_TEST_SECRET)']],
      },
      pool,
    );

    assert.equal(recordedRunId, runId);
    const stepWrite = writes.find(({ sql }) => sql.includes('UPDATE test_run_steps'));
    assert.ok(stepWrite);
    assert.equal(stepWrite.values[0], runId);
    assert.equal(String(stepWrite.values[5]).includes('do-not-log-this-secret'), false);
    assert.match(String(stepWrite.values[5]), /\[REDACTED\]/);
    assert.ok(writes.some(({ sql }) => sql.includes('SET status = $2, completed_at = NOW()')));
  } finally {
    if (previousSecret === undefined) {
      delete process.env.DEV_LOG_TEST_SECRET;
    } else {
      process.env.DEV_LOG_TEST_SECRET = previousSecret;
    }
  }
});
