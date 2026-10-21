import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Pool } from 'pg';
import { runCommand } from '../core/command.js';
import { beginShutdown } from '../core/shutdown.js';
import { syncSprintToGit } from './git-sync.js';

// Eigene Datei: beginShutdown gilt für den ganzen Prozess (der Test-Runner startet je Datei einen eigenen).
test('Neustart beendet das Test-Gate: Sprint-Sicherung wieder „pending“ statt „failed“ (Autopilot pausiert nicht)', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'git-gate-shutdown-'));
  await writeFile(join(cwd, 'a.txt'), 'x');
  const updates: { sql: string; values: unknown[] }[] = [];
  let claimed = false;
  const pool = {
    query: async (sql: string, values: unknown[] = []) => {
      updates.push({ sql, values });
      if (sql.includes("SET git_sync = 'running'") && !claimed) {
        claimed = true;
        return {
          rows: [
            {
              id: 'abcdef12-0000-0000-0000-000000000000',
              name: 'Sprint 1',
              action: 'push',
              remote: null,
              status: 'completed',
            },
          ],
        };
      }
      if (sql.includes('test_commands')) return { rows: [{ commands: [['npm', 'run', 'test:full']] }] };
      return { rows: [] };
    },
  } as unknown as Pool;
  const pushed: string[][] = [];
  const result = await syncSprintToGit(pool, 'p', cwd, async (command, dir, options) => {
    // Das Test-Gate läuft, als der Neustart kommt: Der Prozess wird beendet und meldet einen Fehler-Exit-Code.
    if (command[0] === 'npm') {
      beginShutdown();
      return { exitCode: 1, durationMs: 1, output: 'Process ended by SIGKILL (timeout or kill).' };
    }
    if (command[1] === 'push') pushed.push(command);
    return runCommand(command, dir, options);
  });
  assert.equal(result, 0);
  assert.deepEqual(pushed, []);
  assert.ok(!updates.some((update) => update.sql.includes("git_sync = 'failed'")), 'nicht als gescheitert markiert');
  const requeued = updates.find((update) => update.sql.includes("SET git_sync = 'pending', git_message"));
  assert.ok(requeued, 'wieder eingereiht');
  assert.match(String(requeued.values[1]), /Neustart unterbrochen/);
});
