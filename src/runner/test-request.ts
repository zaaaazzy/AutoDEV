import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { Pool } from 'pg';
import { type CommandExecutor, runCommand } from '../core/command.js';
import { withProjectLock } from '../core/project-lock.js';
import { sendPush } from '../core/push.js';
import { fileBugs, stepBug } from '../core/test-bugs.js';
import { agentEnvironment } from './runner-prompts.js';
import type { RunnerOptions } from './runner-types.js';
import { runTestAgent } from './test-agent.js';

/** Ein Komplettlauf mit Playwright dauert; danach gilt er als hängend. */
const TEST_TIMEOUT_MS = 60 * 60_000;
const DEFAULT_COMMANDS = [
  ['npm', 'run', 'build'],
  ['npm', 'test'],
];

interface Claimed {
  id: string;
  scope: 'full' | 'ui';
}

/**
 * Im eigenen Agenten-Worktree (…-agents, siehe agent-workspace.ts) steht oft noch der Stand des letzten Auftrags.
 * Getestet werden soll der aktuelle Stand: ist der Worktree sauber, wird main ausgecheckt (losgelöst, ohne Branch).
 */
export async function useLatestMain(cwd: string, execute: CommandExecutor): Promise<void> {
  if (!basename(cwd).endsWith('-agents')) return;
  // Nicht versionierte Dateien stören den Checkout nicht; nur echte Änderungen verhindern ihn.
  const status = await execute(['git', 'status', '--porcelain', '--untracked-files=no'], cwd, { timeoutMs: 30_000 });
  if (status.exitCode !== 0 || status.output.trim()) return;
  await execute(['git', 'checkout', '-q', '--detach', 'main'], cwd, { timeoutMs: 60_000 });
}

/** Projekte mit eigenem Komplettlauf (Skript „test:full“, wie Dev Log selbst) nutzen ihn, sonst die Testbefehle. */
export async function hasFullTestScript(cwd: string): Promise<boolean> {
  try {
    const manifest = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    return typeof manifest.scripts?.['test:full'] === 'string';
  } catch {
    return false;
  }
}

export function fullTestCommand(project: string, request: Claimed): string[] {
  return [
    'npm',
    'run',
    'test:full',
    '--',
    '--projekt',
    project,
    '--anfrage',
    request.id,
    '--bugs',
    ...(request.scope === 'ui' ? ['--nur-oberflaeche'] : []),
  ];
}

/** Die aussagekräftigen letzten Zeilen einer Ausgabe (ohne Leerzeilen), für die Statuszeile der Anforderung. */
export function failureTail(output: string): string {
  const lines = output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const error = lines.find((line) => /^Error:/.test(line));
  return (
    (error ?? lines.slice(-3).join(' · ') ?? 'Testbefehl fehlgeschlagen.').slice(0, 500) || 'Testbefehl fehlgeschlagen.'
  );
}

/** Holt die älteste Testanforderung des Projekts und führt sie aus; false, wenn nichts anstand. */
export async function processTestRequest(
  pool: Pool,
  options: Pick<RunnerOptions, 'project' | 'cwd'>,
  execute: CommandExecutor = runCommand,
): Promise<boolean> {
  const request = (
    await pool.query<Claimed>(
      `UPDATE test_requests SET status = 'running', started_at = NOW()
        WHERE id = (SELECT id FROM test_requests WHERE project_slug = $1 AND status = 'requested'
                     ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
          -- Nicht neben einem laufenden Auftrag: der Agent schreibt sonst gleichzeitig im Projektordner.
          AND NOT EXISTS (SELECT 1 FROM agent_runs r JOIN development_items d ON d.id = r.development_id
                           WHERE d.project_slug = $1 AND r.status = 'running')
        RETURNING id, scope`,
      [options.project],
    )
  ).rows[0];
  if (!request) return false;
  console.info(`[${options.project}] Kompletter Test (${request.scope}) startet`);
  try {
    // Unter der Projektsperre: kein Agent und kein Git-Sync arbeitet währenddessen im Ordner.
    const result = await withProjectLock(options.cwd, async () => {
      await useLatestMain(options.cwd, execute);
      if (await hasFullTestScript(options.cwd)) {
        const outcome = await execute(fullTestCommand(options.project, request), options.cwd, {
          timeoutMs: TEST_TIMEOUT_MS,
          env: agentEnvironment(),
        });
        const linked = (
          await pool.query<{ runId: string | null }>('SELECT run_id AS "runId" FROM test_requests WHERE id = $1', [
            request.id,
          ])
        ).rows[0]?.runId;
        // Ohne Testlauf ist der Befehl schon vor den Tests gescheitert (z. B. Port belegt): Ausgabe als Fehler zeigen.
        if (outcome.exitCode !== 0 && !linked) throw new Error(failureTail(outcome.output));
        return { passed: outcome.exitCode === 0, output: outcome.output };
      }
      const commands =
        (
          await pool.query<{ commands: string[][] | null }>(
            'SELECT test_commands AS commands FROM projects WHERE slug = $1',
            [options.project],
          )
        ).rows[0]?.commands ?? DEFAULT_COMMANDS;
      const runId = await runTestAgent(
        { project: options.project, cwd: options.cwd, commands, existingProject: true, timeoutMs: TEST_TIMEOUT_MS },
        pool,
      );
      await pool.query('UPDATE test_requests SET run_id = $2 WHERE id = $1', [request.id, runId]);
      const failed = (
        await pool.query<{ command: string; output: string }>(
          `SELECT command, output FROM test_run_steps WHERE run_id = $1 AND status = 'failed' ORDER BY position`,
          [runId],
        )
      ).rows;
      const bugs = await fileBugs(
        pool,
        options.project,
        failed.map((step) => stepBug(step.command, step.output, runId)),
      );
      await pool.query('UPDATE test_requests SET bug_count = $2 WHERE id = $1', [request.id, bugs]);
      return { passed: failed.length === 0, output: '' };
    });
    const row = (
      await pool.query<{ bugs: number; runId: string | null }>(
        `UPDATE test_requests SET status = 'done', finished_at = NOW() WHERE id = $1
         RETURNING bug_count AS bugs, run_id AS "runId"`,
        [request.id],
      )
    ).rows[0];
    await sendPush(
      pool,
      {
        title: `${result.passed ? '✅' : '❌'} Kompletter Test · ${options.project}`,
        body: result.passed
          ? 'Alle Prüfungen bestanden.'
          : `Mit Befunden${row?.bugs ? ` – ${row.bugs} neue Bugs angelegt` : ''}.`,
        url: row?.runId ? `#runs/${row.runId}` : '#runs',
        tag: `test-${request.id}`,
      },
      { project: options.project },
    ).catch(() => undefined);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await pool.query(`UPDATE test_requests SET status = 'failed', finished_at = NOW(), error = $2 WHERE id = $1`, [
      request.id,
      message.slice(0, 2000),
    ]);
  }
  return true;
}

/** Nach einem Neustart des Workers: angefangene Testanforderungen und ihre Läufe gelten als abgebrochen. */
export async function recoverTestRequests(pool: Pool): Promise<void> {
  await pool.query(
    `UPDATE test_runs SET status = 'failed', completed_at = NOW()
      WHERE status = 'running' AND id IN (SELECT run_id FROM test_requests WHERE status = 'running')`,
  );
  await pool.query(
    `UPDATE test_requests SET status = 'failed', finished_at = NOW(), error = 'Worker wurde neu gestartet.'
      WHERE status = 'running'`,
  );
}
