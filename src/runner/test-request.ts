import { logged } from '../core/log.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { type CommandExecutor, runCommand } from '../core/command.js';
import { acquireTree, withProjectLock } from '../core/project-lock.js';
import { adminDatabaseUrl } from '../core/local-database.js';
import { sendPush } from '../core/push.js';
import { fileBugs, stepBug } from '../core/test-bugs.js';
import { dropReportCopies } from './git-sync/report-copies.js';
import { gitEnvironment, projectEnvironment, runProjectCommand } from './project-command.js';
import type { RunnerOptions } from './runner-types.js';
import { runTestAgent } from './test-agent.js';
import { isAllowedCommand, shellWords, withIgnoreScripts } from '../agent/command-checks.js';
import { gateExecutor } from './test-sandbox.js';

/** Ein Komplettlauf mit Playwright dauert; danach gilt er als hängend. */
const TEST_TIMEOUT_MS = 60 * 60_000;
const DEFAULT_COMMANDS = [
  ['npm', 'run', 'build'],
  ['npm', 'test'],
];

interface Claimed {
  id: string;
  scope: 'full' | 'ui' | 'befehl';
  evidenceId: string | null;
}

/**
 * Befehl eines Testnachweises (Umfang „befehl“): nur aus der gespeicherten Zeile, nie aus dem Request. Er stammt aus
 * einer Agent-Ausgabe und ist nicht vertrauenswürdig: Lehnt isAllowedCommand ihn ab, startet nichts, und der Nachweis
 * erhält den Status „nicht_freigegeben“. Liefert die Argumentliste (ohne Shell) für den Testlauf.
 */
export async function evidenceCommand(
  pool: Pick<Pool, 'query'>,
  project: string,
  evidenceId: string | null,
  cwd: string,
): Promise<string[]> {
  const row = evidenceId
    ? (
        await pool.query<{ befehl: string }>(
          `SELECT e.befehl FROM test_evidence e JOIN development_items d ON d.id = e.development_id
            WHERE e.id = $1 AND d.project_slug = $2`,
          [evidenceId, project],
        )
      ).rows[0]
    : undefined;
  if (!row) throw new Error('Testnachweis nicht gefunden.');
  if (!isAllowedCommand(row.befehl, cwd)) {
    await pool.query(`UPDATE test_evidence SET status = 'nicht_freigegeben' WHERE id = $1`, [evidenceId]);
    throw new Error(`Befehl nicht freigegeben: ${row.befehl}`);
  }
  // Installationen laufen auch hier ohne Installationsskripte.
  return withIgnoreScripts(shellWords(row.befehl));
}

/**
 * Im eigenen Agenten-Worktree (siehe agent-workspace.ts) steht oft noch der Stand des letzten Auftrags.
 * Getestet werden soll der aktuelle Stand: ist der Worktree sauber, wird main ausgecheckt (losgelöst, ohne Branch).
 * Liefert den Branch, auf dem der Worktree vorher stand (für restoreBranch), sonst null.
 * Offene Änderungen (oder ein gescheitertes git status) werfen: sonst prüfte der Lauf einen halbfertigen Auftrag.
 */
export async function useLatestMain(cwd: string, execute: CommandExecutor): Promise<string | null> {
  const git = (...args: string[]) => execute(['git', ...args], cwd, { timeoutMs: 60_000, env: gitEnvironment() });
  // Nur in einem verknüpften Worktree (eigenes Git-Verzeichnis ≠ gemeinsames), unabhängig vom Ordnernamen.
  const dirs = await git('rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir');
  const [own, common] = dirs.output.trim().split('\n');
  if (dirs.exitCode !== 0 || !own || own === common) return null;
  // Nicht versionierte Dateien stören den Checkout nicht; nur echte Änderungen verhindern ihn.
  const status = await git('status', '--porcelain', '--untracked-files=no');
  if (status.exitCode !== 0)
    throw new Error(
      `git status im Agent-Worktree fehlgeschlagen – Test auf main nicht möglich: ${failureTail(status.output)}`,
    );
  if (status.output.trim())
    throw new Error('Offene Änderungen im Agent-Worktree (wartender Auftrag?) – Test auf main nicht möglich.');
  const branch = await git('symbolic-ref', '--short', '-q', 'HEAD');
  await dropReportCopies(git, cwd, 'main');
  const moved = await git('checkout', '-q', '--detach', 'main');
  return moved.exitCode === 0 && branch.exitCode === 0 ? branch.output.trim() || null : null;
}

/** Nach dem Test zurück auf den Branch von vorher, damit der nächste Auftrag nicht von einem losgelösten Stand startet. */
export async function restoreBranch(cwd: string, branch: string | null, execute: CommandExecutor): Promise<void> {
  if (!branch) return;
  const restored = await execute(['git', 'checkout', '-q', branch], cwd, { timeoutMs: 60_000, env: gitEnvironment() });
  if (restored.exitCode !== 0)
    console.error(`Nach dem Test nicht zurück auf ${branch}: ${restored.output.slice(-300)}`);
}

/** Projekte mit eigenem Komplettlauf (Skript „test:full“, wie AIdeation selbst) nutzen ihn, sonst die Testbefehle. */
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

/**
 * Zusätzliche Variablen für den Komplettlauf: test:full schreibt den Lauf in die AIdeation-Datenbank und der
 * E2E-Webserver legt daneben seine eigene Testdatenbank an. Nur diese beiden Zugänge kommen zur gefilterten
 * Umgebung hinzu (kein Secret Key, keine anderen DEV_LOG_*-Werte). Ohne DEV_LOG_DATABASE_URL im Worker nichts.
 */
export function fullTestExtraEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const databaseUrl = source.DEV_LOG_DATABASE_URL?.trim();
  if (!databaseUrl) return {};
  let admin = source.E2E_ADMIN_DATABASE_URL?.trim() || source.DEV_LOG_ADMIN_DATABASE_URL?.trim();
  try {
    admin ||= adminDatabaseUrl(databaseUrl);
  } catch {
    // Unlesbare Adresse: kein Admin-Ziel, der E2E-Webserver liest es dann selbst aus der .env.
  }
  return { DEV_LOG_DATABASE_URL: databaseUrl, ...(admin ? { E2E_ADMIN_DATABASE_URL: admin } : {}) };
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
  runAgent: typeof runTestAgent = runTestAgent,
): Promise<boolean> {
  const request = (
    await pool.query<Claimed>(
      `UPDATE test_requests SET status = 'running', started_at = NOW()
        WHERE id = (SELECT id FROM test_requests WHERE project_slug = $1 AND status = 'requested'
                     ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
          -- Nicht neben einem laufenden Auftrag: der Agent schreibt sonst gleichzeitig im Projektordner.
          AND NOT EXISTS (SELECT 1 FROM agent_runs r JOIN development_items d ON d.id = r.development_id
                           WHERE d.project_slug = $1 AND r.status = 'running')
        RETURNING id, scope, evidence_id AS "evidenceId"`,
      [options.project],
    )
  ).rows[0];
  if (!request) return false;
  console.info(`[${options.project}] Kompletter Test (${request.scope}) startet`);
  const evidence = request.scope === 'befehl';
  try {
    // Testnachweis: Befehl vor dem Start prüfen – abgelehnt startet gar nichts (kein Lauf, kein Checkout).
    const evidenceArgs = evidence
      ? await evidenceCommand(pool, options.project, request.evidenceId, options.cwd)
      : null;
    // Unter der Projektsperre: kein Agent und kein Git-Sync arbeitet währenddessen im Ordner.
    // Exklusiv im Arbeitsordner: kein Auftrag wechselt währenddessen den Branch, kein Assistent schreibt hinein.
    const releaseTree = await acquireTree(options.cwd);
    let previous: string | null = null;
    const result = await withProjectLock(options.cwd, async () => {
      previous = await useLatestMain(options.cwd, execute);
      // Projektcode im Testcontainer (Sandbox, Standard); Git bleibt beim Worker. Im Container gibt es keinen Zugang
      // zur AIdeation-Datenbank: test:full meldet dann nur Exit-Code und Ausgabe, keinen eigenen Testlauf.
      const testExecute = await gateExecutor(pool, options.project, options.cwd, execute, `test-${request.id}`);
      if (!evidenceArgs && (await hasFullTestScript(options.cwd))) {
        const outcome = await runProjectCommand(
          fullTestCommand(options.project, request),
          options.cwd,
          { timeoutMs: TEST_TIMEOUT_MS, extraEnv: fullTestExtraEnv() },
          testExecute,
        );
        const linked = (
          await pool.query<{ runId: string | null }>('SELECT run_id AS "runId" FROM test_requests WHERE id = $1', [
            request.id,
          ])
        ).rows[0]?.runId;
        // Ohne Testlauf ist der Befehl schon vor den Tests gescheitert (z. B. Port belegt): Ausgabe als Fehler zeigen.
        if (outcome.exitCode !== 0 && !linked) throw new Error(failureTail(outcome.output));
        return { passed: outcome.exitCode === 0, output: outcome.output };
      }
      const commands = evidenceArgs
        ? [evidenceArgs]
        : ((
            await pool.query<{ commands: string[][] | null }>(
              'SELECT test_commands AS commands FROM projects WHERE slug = $1',
              [options.project],
            )
          ).rows[0]?.commands ?? DEFAULT_COMMANDS);
      const runId = await runAgent(
        {
          project: options.project,
          cwd: options.cwd,
          commands,
          existingProject: true,
          env: projectEnvironment(options.cwd),
          timeoutMs: TEST_TIMEOUT_MS,
          ...(testExecute !== execute ? { execute: testExecute } : {}),
          // Sofort verknüpfen: bei Neustart oder Fehler während der Befehle findet recoverTestRequests den Lauf.
          onRunCreated: async (created) => {
            await pool.query('UPDATE test_requests SET run_id = $2 WHERE id = $1', [request.id, created]);
          },
        },
        pool,
      );
      const failed = (
        await pool.query<{ command: string; output: string }>(
          `SELECT command, output FROM test_run_steps WHERE run_id = $1 AND status = 'failed' ORDER BY position`,
          [runId],
        )
      ).rows;
      if (evidenceArgs) {
        // Grün hakt den Nachweis ab; rot bleibt er unter „Aktion notwendig“ sichtbar (keine Bugs aus dem Einzelbefehl).
        await pool.query(`UPDATE test_evidence SET status = $2, run_id = $3, checked_at = NOW() WHERE id = $1`, [
          request.evidenceId,
          failed.length === 0 ? 'passed' : 'failed',
          runId,
        ]);
        return { passed: failed.length === 0, output: '' };
      }
      const bugs = await fileBugs(
        pool,
        options.project,
        failed.map((step) => stepBug(step.command, step.output, runId)),
      );
      await pool.query('UPDATE test_requests SET bug_count = $2 WHERE id = $1', [request.id, bugs]);
      return { passed: failed.length === 0, output: '' };
    }).finally(() =>
      withProjectLock(options.cwd, () => restoreBranch(options.cwd, previous, execute)).finally(releaseTree),
    );
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
        title: `${result.passed ? '✅' : '❌'} ${evidence ? 'Testnachweis' : 'Kompletter Test'} · ${options.project}`,
        body: evidence
          ? result.passed
            ? 'Nachweis erbracht und abgehakt.'
            : 'Befehl ist rot – der Nachweis bleibt unter „Aktion notwendig“.'
          : result.passed
            ? 'Alle Prüfungen bestanden.'
            : `Mit Befunden${row?.bugs ? ` – ${row.bugs} neue Bugs angelegt` : ''}.`,
        url: `${row?.runId ? `#runs/${row.runId}` : '#runs'}?project=${encodeURIComponent(options.project)}`,
        tag: `test-${request.id}`,
      },
      { project: options.project },
    ).catch(logged('test-request'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Ein schon verknüpfter Lauf darf nicht auf „running“ stehen bleiben.
    await pool
      .query(
        `UPDATE test_runs SET status = 'failed', completed_at = NOW()
          WHERE status = 'running' AND id = (SELECT run_id FROM test_requests WHERE id = $1)`,
        [request.id],
      )
      .catch(logged('test-request'));
    // Testnachweis mit schon angelegtem Lauf: gilt als rot (sichtbar, mit diesem Lauf), nie als abgehakt – auch bei
    // erneutem Start eines schon roten Nachweises.
    if (evidence) {
      await pool
        .query(
          `UPDATE test_evidence e SET status = 'failed', run_id = r.run_id, checked_at = NOW()
             FROM test_requests r
            WHERE r.id = $1 AND e.id = r.evidence_id AND r.run_id IS NOT NULL AND e.status IN ('open', 'failed')`,
          [request.id],
        )
        .catch(logged('test-request'));
    }
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
