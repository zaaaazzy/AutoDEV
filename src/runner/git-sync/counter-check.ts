// Gegenprobe nach einem Bugfix: die geänderten Testdateien des Auftrags auf dem Stand vor dem Fix ausführen.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { Pool } from 'pg';
import { type CommandExecutor, redactOutput } from '../../core/command.js';
import { isShuttingDown } from '../../core/shutdown.js';
import { createTestRun, finishTestRun, saveTestReport } from '../../db/test-runs.js';
import { linkDependencies } from '../agent-workspace.js';
import { expandOrderCommands, isPlaywrightTest, isTestFile, TESTS_PLACEHOLDER } from '../order-tests.js';
import { runProjectCommand } from '../project-command.js';
import { loadOrderTestCommands } from '../runner-selection.js';
import { classifyTestFileRun, gateFailureSummary, loadErrorLine } from './ci.js';
import { CHANGED_FILES_IGNORED, gitHelpers } from './git-helpers.js';

/** Losgelöste Worktrees der Gegenprobe liegen im Temp-Ordner mit diesem Präfix (verwaiste werden beim Start entfernt). */
export const COUNTER_CHECK_PREFIX = 'aideation-gegenprobe-';
/** Je Testbefehl und insgesamt je Sicherung: Das Test-Gate hat schon bis zu 45 Minuten der Stundengrenze verbraucht. */
const COMMAND_TIMEOUT_MS = 5 * 60_000;
export const COUNTER_CHECK_BUDGET_MS = 10 * 60_000;
const DETAIL_CHARS = 300;

/**
 * Ergebnis je Testdatei: fails = scheitert ohne Fix, passes = läuft auch ohne Fix grün, import = bricht beim Import
 * ab, skipped = nicht bewertet (Playwright), error = die Gegenprobe selbst ist gescheitert (Zeit, Befehl, Sandbox).
 */
export type CounterCheckResult = 'fails' | 'passes' | 'import' | 'skipped' | 'error';

export interface CounterCheckFile {
  path: string;
  result: CounterCheckResult;
  detail?: string;
}

/** Gespeichert in development_items.counter_check; NULL heisst „keine Gegenprobe“. */
export interface CounterCheck {
  checkedAt: string;
  /** Stand ohne Fix (erster Elternteil des Auftrags-Commits) und Auftrags-Commit, voll ausgeschrieben. */
  base: string | null;
  commit: string | null;
  files: CounterCheckFile[];
  /** Fehler der Gegenprobe selbst (kein Commit, kein Worktree, keine Testbefehle): sichtbar, aber kein Blocker. */
  error?: string;
  /** Testlauf, dessen Bericht die Gegenprobe enthält. */
  runId?: string;
}

export const COUNTER_CHECK_LABELS: Record<CounterCheckResult, string> = {
  fails: 'scheitert ohne Fix',
  passes: 'läuft auch ohne Fix grün',
  import: 'bricht beim Import ab',
  skipped: 'nicht bewertet',
  error: 'Gegenprobe gescheitert',
};

/** Testdateien des Auftrags, die eine Gegenprobe bekommen (ohne interne Ordner). */
export function counterCheckFiles(changed: readonly string[]): string[] {
  return changed.filter((path) => isTestFile(path) && !CHANGED_FILES_IGNORED.some((prefix) => path.startsWith(prefix)));
}

/** Gegenprobe nur für Bugfixes mit mindestens einer geänderten Testdatei. */
export function needsCounterCheck(order: { kind?: string | null; changedFiles?: readonly string[] | null }): boolean {
  return order.kind === 'bug' && counterCheckFiles(order.changedFiles ?? []).length > 0;
}

/** Entfernt Worktrees früherer, hart abgebrochener Gegenproben (SIGKILL, Neustart) und räumt die Liste auf. */
export async function pruneCounterCheckWorktrees(cwd: string, execute: CommandExecutor): Promise<void> {
  const { git } = gitHelpers(execute, cwd);
  const list = await git('worktree', 'list', '--porcelain');
  for (const line of list.exitCode === 0 ? list.output.split('\n') : []) {
    const path = line.startsWith('worktree ') ? line.slice('worktree '.length).trim() : '';
    if (!path || !basename(path).startsWith(COUNTER_CHECK_PREFIX)) continue;
    await git('worktree', 'remove', '--force', path);
    await rm(path, { recursive: true, force: true }).catch(() => undefined);
  }
  await git('worktree', 'prune');
}

const shortDetail = (text: string): string => text.replace(/\s+/g, ' ').trim().slice(0, DETAIL_CHARS);

/** Der Befehl lief gar nicht (fehlt im PATH, Sandbox lehnt ab, Zeitüberschreitung): kein Testergebnis. */
function commandProblem(result: { exitCode: number; output: string }, timedOut: boolean): string | null {
  if (timedOut) return 'Zeitüberschreitung des Testbefehls.';
  if (result.output.startsWith('Sandbox:')) return result.output.split('\n', 1)[0] ?? 'Sandbox:';
  if (result.exitCode < 0 || result.exitCode === 127 || /im PATH des Workers nicht gefunden/.test(result.output)) {
    return `Testbefehl nicht ausführbar (Exit-Code ${result.exitCode}).`;
  }
  return null;
}

/**
 * Führt die geänderten Testdateien eines Bugfix-Auftrags in einem eigenen, losgelösten Worktree auf dem Stand vor dem
 * Fix aus: Produktivcode aus dem ersten Elternteil des Auftrags-Commits, Testdateien aus dem Auftrags-Commit. Es laufen
 * nur die Testbefehle je Auftrag mit `{tests}`, einzeln je Datei. Hauptordner, Sprint-Branch, Index und HEAD bleiben
 * unberührt; der Worktree wird immer entfernt. Wirft nie: Fehler stehen in `error` bzw. am Ergebnis der Datei.
 */
export async function counterCheckOrder(options: {
  /** Projekt- bzw. Agent-Ordner mit dem Repository (und node_modules). */
  cwd: string;
  /** Auftrags-Commit (development_items.git_commit). */
  commit: string;
  changedFiles: readonly string[];
  /** Testbefehle je Auftrag (order_test_commands); nur die mit `{tests}` laufen. */
  commands: readonly string[][];
  /** Git auf dem Host. */
  execute: CommandExecutor;
  /** Executor für die Testbefehle im Worktree (Testcontainer der Sandbox oder Host). */
  testExecutor: (folder: string) => Promise<CommandExecutor>;
  /** node_modules des Hauptordners verlinken (nur ohne Sandbox; im Container liefert das Volume sie). */
  linkModules?: boolean;
  /** Zeitpunkt (ms), ab dem keine weiteren Befehle starten. */
  deadline?: number;
  commandTimeoutMs?: number;
}): Promise<CounterCheck> {
  const check: CounterCheck = { checkedAt: new Date().toISOString(), base: null, commit: null, files: [] };
  const { git, must } = gitHelpers(options.execute, options.cwd);
  const wanted = counterCheckFiles(options.changedFiles);
  let worktree: string | null = null;
  try {
    const commit = await must('rev-parse', '--verify', '--quiet', `${options.commit}^{commit}`);
    const parents = (await must('rev-list', '--parents', '-n', '1', commit)).split(/\s+/).slice(1);
    check.commit = commit;
    check.base = parents[0] ?? null;
    if (!check.base) throw new Error(`Auftrags-Commit ${commit.slice(0, 7)} hat keinen Vorgänger.`);
    // Nur Testdateien, die der Auftrags-Commit gegenüber dem Stand ohne Fix wirklich ändert und noch enthält.
    const diff = new Set(
      (await must('-c', 'core.quotePath=false', 'diff', '--name-only', check.base, commit))
        .split('\n')
        .map((line) => line.trim()),
    );
    const present: string[] = [];
    for (const path of wanted) {
      if (!diff.has(path) || (await git('cat-file', '-e', `${commit}:${path}`)).exitCode !== 0) continue;
      const content = await git('show', `${commit}:${path}`);
      if (isPlaywrightTest(path, content.exitCode === 0 ? content.output : undefined)) {
        check.files.push({ path, result: 'skipped', detail: 'Playwright-Tests werden nicht gegengeprüft.' });
      } else {
        present.push(path);
      }
    }
    const runnable = options.commands.filter((command) => command.includes(TESTS_PLACEHOLDER));
    if (!present.length) {
      if (!check.files.length) check.error = 'Keine geänderte Testdatei im Auftrags-Commit gefunden.';
      return check;
    }
    if (!runnable.length) {
      check.error = 'Keine Testbefehle je Auftrag mit {tests} hinterlegt – Gegenprobe nicht möglich.';
      return check;
    }
    await pruneCounterCheckWorktrees(options.cwd, options.execute);
    worktree = await mkdtemp(join(tmpdir(), COUNTER_CHECK_PREFIX));
    // Losgelöst auf dem Stand ohne Fix; „worktree add“ läuft ohne Hooks (gitHelpers).
    await must('worktree', 'add', '--detach', worktree, check.base);
    const inside = gitHelpers(options.execute, worktree);
    // Nur die Testdateien aus dem Auftrags-Commit (Index und Dateien des Gegenprobe-Worktrees, nichts sonst).
    await inside.must('checkout', commit, '--', ...present);
    if (options.linkModules) {
      try {
        linkDependencies(options.cwd, worktree);
      } catch {
        // Ohne Abhängigkeiten scheitern die Tests beim Import – das zeigt das Ergebnis dann auch.
      }
    }
    const execute = await options.testExecutor(worktree);
    const timeoutMs = options.commandTimeoutMs ?? COMMAND_TIMEOUT_MS;
    for (const path of present) {
      const planned = expandOrderCommands(runnable, [path], [path], () => false).filter((entry) => !entry.skipped);
      if (!planned.length) {
        check.files.push({ path, result: 'skipped', detail: 'Kein Testbefehl mit {tests} für diese Datei.' });
        continue;
      }
      let outcome: CounterCheckFile = { path, result: 'passes' };
      for (const { command } of planned) {
        if (options.deadline !== undefined && Date.now() >= options.deadline) {
          outcome = { path, result: 'error', detail: 'Zeitbudget der Gegenprobe erschöpft – nicht ausgeführt.' };
          break;
        }
        const result = await runProjectCommand(command, worktree, { timeoutMs }, execute);
        const output = redactOutput(result.output, process.env);
        const problem = commandProblem(result, result.durationMs >= timeoutMs);
        if (problem) {
          outcome = { path, result: 'error', detail: shortDetail(`${problem} ${command.join(' ')}`) };
          break;
        }
        const classified = classifyTestFileRun(result.exitCode, output, path);
        if (classified === 'passed') continue;
        outcome =
          classified === 'load-error'
            ? { path, result: 'import', detail: shortDetail(loadErrorLine(output) ?? gateFailureSummary(output)) }
            : { path, result: 'fails', detail: shortDetail(gateFailureSummary(output)) };
        break;
      }
      check.files.push(outcome);
    }
    return check;
  } catch (error) {
    check.error = shortDetail(error instanceof Error ? error.message : String(error));
    return check;
  } finally {
    if (worktree) {
      await git('worktree', 'remove', '--force', worktree).catch(() => undefined);
      await rm(worktree, { recursive: true, force: true }).catch(() => undefined);
      await git('worktree', 'prune').catch(() => undefined);
    }
  }
}

/** Eine Zeile je Testdatei für den Testbericht. */
export function counterCheckLines(order: { title: string }, check: CounterCheck): string[] {
  return [
    ...check.files.map(
      (file) =>
        `- \`${file.path}\` („${order.title}“): **${COUNTER_CHECK_LABELS[file.result]}**${
          file.result === 'passes' ? ' – der Test beweist den Fix nicht' : ''
        }${file.detail && file.result !== 'passes' ? ` – ${file.detail}` : ''}`,
    ),
    ...(check.error ? [`- „${order.title}“: **${COUNTER_CHECK_LABELS.error}** – ${check.error}`] : []),
  ];
}

/** Testbericht der Gegenprobe (Markdown, eine Zeile je geprüfter Testdatei). */
export function counterCheckReport(sprintName: string, checks: { title: string; check: CounterCheck }[]): string {
  return [
    `# Gegenprobe: neue Tests ohne den Fix (${sprintName})`,
    '',
    'Geänderte Testdateien der Bugfix-Aufträge, ausgeführt auf dem Stand vor dem Fix. Rein informativ: Das Ergebnis',
    'blockiert weder Push noch Merge. Erwartet ist „scheitert ohne Fix“.',
    '',
    ...checks.flatMap(({ title, check }) => counterCheckLines({ title }, check)),
    '',
  ].join('\n');
}

interface PendingOrder {
  id: string;
  title: string;
  commit: string | null;
  changedFiles: string[];
}

/**
 * Gegenprobe für die erledigten Bugfix-Aufträge eines Sprints, die noch keine haben: nach dem grünen Test-Gate, ohne
 * Einfluss auf Push und Merge. Ergebnis am Auftrag (counter_check) und als Testbericht. Liefert eine Zeile fürs
 * Sprint-Log oder null (nichts zu prüfen). Wirft nie.
 */
export async function runSprintCounterChecks(options: {
  pool: Pool;
  project: string;
  sprint: { id: string; name: string; branch?: string | null };
  cwd: string;
  execute: CommandExecutor;
  testExecutor: (folder: string) => Promise<CommandExecutor>;
  linkModules: boolean;
}): Promise<string | null> {
  const { pool } = options;
  try {
    const orders = (
      await pool.query<PendingOrder>(
        `SELECT id, title, git_commit AS commit, changed_files AS "changedFiles" FROM development_items
          WHERE sprint_id = $1 AND kind = 'bug' AND status = 'done' AND counter_check IS NULL
          ORDER BY completed_at NULLS LAST, created_at`,
        [options.sprint.id],
      )
    ).rows.filter((order) => needsCounterCheck({ kind: 'bug', changedFiles: order.changedFiles }));
    if (!orders.length) return null;
    const commands = (await loadOrderTestCommands(pool, options.project)) ?? [];
    const deadline = Date.now() + COUNTER_CHECK_BUDGET_MS;
    const runId = await createTestRun(pool, {
      projectSlug: options.project,
      trigger: 'counter-check',
      branch: options.sprint.branch ?? null,
      commitSha: null,
    });
    const checks: { title: string; check: CounterCheck }[] = [];
    for (const order of orders) {
      const check: CounterCheck = order.commit
        ? await counterCheckOrder({
            cwd: options.cwd,
            commit: order.commit,
            changedFiles: order.changedFiles,
            commands,
            execute: options.execute,
            testExecutor: options.testExecutor,
            linkModules: options.linkModules,
            deadline,
          })
        : {
            checkedAt: new Date().toISOString(),
            base: null,
            commit: null,
            files: [],
            error: 'Kein Auftrags-Commit vermerkt (z. B. nach einer Review-Freigabe) – Gegenprobe nicht möglich.',
          };
      // Neustart des Workers: Befehle wurden abgeschossen, das ist kein Ergebnis. Der Auftrag bleibt ohne Gegenprobe
      // und wird bei der nächsten Sicherung geprüft.
      if (isShuttingDown()) break;
      check.runId = runId;
      checks.push({ title: order.title, check });
      await pool.query('UPDATE development_items SET counter_check = $2::jsonb WHERE id = $1', [
        order.id,
        JSON.stringify(check),
      ]);
    }
    await saveTestReport(pool, runId, counterCheckReport(options.sprint.name, checks));
    // Der Lauf selbst ist durchgelaufen; was die Dateien ergaben, steht im Bericht (kein roter Testlauf im Dashboard).
    await finishTestRun(pool, runId, true);
    const files = checks.flatMap(({ check }) => check.files);
    const count = (result: CounterCheckResult) => files.filter((file) => file.result === result).length;
    const errors = checks.filter(({ check }) => check.error).length + count('error');
    return `Gegenprobe (${files.length} Testdatei${files.length === 1 ? '' : 'en'}): ${count('fails')} scheitern ohne Fix, ${count('passes')} auch ohne Fix grün, ${count('import')} brechen beim Import ab${errors ? `, ${errors} nicht prüfbar` : ''}.`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Gegenprobe für Sprint ${options.sprint.id} fehlgeschlagen: ${message}`);
    return `Gegenprobe nicht gelaufen: ${shortDetail(message)}`;
  }
}
