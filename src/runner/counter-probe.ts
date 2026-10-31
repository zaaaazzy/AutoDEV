// Gegenprobe im Tester-Schritt eines Bugfixes: nur die neu hinzugekommenen Testfälle auf dem Stand vor dem Auftrag.
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { Pool } from 'pg';
import { type CommandExecutor, redactOutput } from '../core/command.js';
import {
  COUNTER_PROBE_LABELS,
  type CounterProbeCase,
  type CounterProbeVerdict,
  UNPROVEN_FIX_MARK,
} from '../core/shared-types.js';
import { saveCounterCheck } from '../db/development-repository.js';
import { linkDependencies } from './agent-workspace.js';
import { classifyTestFileRun, loadErrorLine } from './git-sync/ci.js';
import { type CounterCheck, commandProblem, counterCheckFiles, shortDetail } from './git-sync/counter-check.js';
import { gitHelpers } from './git-sync/git-helpers.js';
import { expandOrderCommands, isPlaywrightTest, TESTS_PLACEHOLDER } from './order-tests.js';
import { runProjectCommand } from './project-command.js';
import { loadOrderTestCommands } from './runner-selection.js';

/**
 * Eigenes Präfix: Die Gegenprobe je Datei beim Sprint-Abschluss räumt alle Worktrees mit „aideation-gegenprobe-“ ab und
 * dürfte eine gerade laufende Gegenprobe im Tester-Schritt nicht treffen.
 */
export const COUNTER_PROBE_PREFIX = 'aideation-probe-';
const COMMAND_TIMEOUT_MS = 5 * 60_000;
const PROBE_BUDGET_MS = 10 * 60_000;
/** Worktrees früherer, hart abgebrochener Gegenproben (SIGKILL) gelten nach zwei Stunden als verwaist. */
const STALE_MS = 2 * 60 * 60_000;

/**
 * Aufrufe `test('…')` und `it('…')` (auch `.only`) mit festem Namen. `t.test(…)`, `.skip`/`.todo` und Namen mit `${…}`
 * zählen nicht: Sie laufen nicht bzw. lassen sich nicht über den Namen filtern. Ein vorangestelltes Wortzeichen (etwa
 * das „n“ aus `\n` in einem Fixture-String) schliesst Aufrufe aus, die nur als Text im Test stehen.
 */
const CASE_CALL = /(?<![\w.$])(?:test|it)(?:\.only)?\s*\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;

/** Namen der Testfälle einer Testdatei, ohne Doppelte, in Reihenfolge des Vorkommens. */
export function testCaseNames(source: string): string[] {
  const names = new Set<string>();
  for (const match of source.matchAll(CASE_CALL)) {
    const raw = match[2] ?? '';
    if (match[1] === '`' && raw.includes('${')) continue;
    const name = raw.replace(/\\(.)/g, '$1').trim();
    if (name) names.add(name);
  }
  return [...names];
}

/** Testfälle, die der Auftrag hinzugefügt hat: Namen, die es vorher nicht gab (neue Datei: alle). */
export function newTestCases(before: string | null, after: string): string[] {
  const old = new Set(before === null ? [] : testCaseNames(before));
  return testCaseNames(after).filter((name) => !old.has(name));
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Namensfilter für node --test/tsx --test: genau diese Testfälle, auch in describe (dort mit Präfix und Leerzeichen). */
export function namePattern(names: readonly string[]): string {
  return `(?:^| )(?:${names.map(escapeRegExp).join('|')})$`;
}

/** Setzt den Namensfilter direkt vor den Platzhalter {tests}; Befehle ohne Platzhalter laufen bei der Gegenprobe nicht. */
export function withNameFilter(command: readonly string[], names: readonly string[]): string[] {
  return command.flatMap((part) =>
    part === TESTS_PLACEHOLDER ? [`--test-name-pattern=${namePattern(names)}`, part] : [part],
  );
}

type CaseStatus = 'passed' | 'failed' | 'skipped';
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const TAP_CASE = /^(not ok|ok) \d+ - (.+?)(?:\s+#\s*(SKIP|TODO)\b.*)?$/;
const SPEC_CASE = /^([✔✖﹣])\s+(.+?)(?:\s+\([\d.]+m?s\))?(?:\s+#\s*(SKIP|TODO)\b.*)?$/;
const RANK: Record<CaseStatus, number> = { skipped: 0, passed: 1, failed: 2 };

/** Ergebnis je Testfall aus TAP- oder Spec-Ausgabe von node:test; ein Fehlschlag überwiegt (gleichnamige Fälle). */
export function caseStatuses(output: string): Map<string, CaseStatus> {
  const statuses = new Map<string, CaseStatus>();
  for (const raw of output.replace(ANSI, '').split('\n')) {
    const line = raw.trim();
    const tap = TAP_CASE.exec(line);
    const spec = tap ? null : SPEC_CASE.exec(line);
    const match = tap ?? spec;
    if (!match) continue;
    const name = (match[2] ?? '').replace(/\\#/g, '#').trim();
    const status: CaseStatus =
      match[3] || match[1] === '﹣' ? 'skipped' : match[1] === 'ok' || match[1] === '✔' ? 'passed' : 'failed';
    const known = statuses.get(name);
    if (!known || RANK[status] > RANK[known]) statuses.set(name, status);
  }
  return statuses;
}

export interface ProbeRun {
  exitCode: number;
  output: string;
  /** Der Befehl lief gar nicht (Zeitüberschreitung, Sandbox, fehlt im PATH). */
  problem: string | null;
}

/**
 * Ergebnis je Testfall einer Datei. Lade-, Import- und Kompilierfehler sowie ein Befehl, der nicht lief, ergeben
 * „nicht auswertbar“ – nie „scheitert wie erwartet“, sonst gälte ein Test als Beleg, der aus dem falschen Grund rot ist.
 */
export function classifyCases(file: string, names: readonly string[], run: ProbeRun): CounterProbeCase[] {
  const all = (detail: string): CounterProbeCase[] =>
    names.map((name) => ({ file, name, result: 'inconclusive', detail: shortDetail(detail) }));
  if (run.problem) return all(run.problem);
  if (classifyTestFileRun(run.exitCode, run.output, file) === 'load-error') {
    return all(`Lade- oder Importfehler auf dem alten Stand: ${loadErrorLine(run.output) ?? 'siehe Testausgabe'}`);
  }
  const statuses = caseStatuses(run.output);
  return names.map((name): CounterProbeCase => {
    const status = statuses.get(name);
    if (status === 'failed') return { file, name, result: 'fails' };
    if (status === 'passed') return { file, name, result: 'passes' };
    return {
      file,
      name,
      result: 'inconclusive',
      detail: status === 'skipped' ? 'übersprungen' : 'nicht ausgeführt (Namensfilter ohne Treffer)',
    };
  });
}

/** Urteil über alle neuen Testfälle; nur „unproven“ gibt den Auftrag zurück. */
export function probeVerdict(cases: readonly CounterProbeCase[]): CounterProbeVerdict {
  if (!cases.length) return 'none';
  if (cases.some((entry) => entry.result === 'passes')) return 'unproven';
  return cases.every((entry) => entry.result === 'fails') ? 'proven' : 'inconclusive';
}

export interface ProbeTarget {
  file: string;
  names: string[];
  /** Inhalt der Testdatei im Auftrag (Arbeitsordner, auch noch nicht committet). */
  content: string;
}

/**
 * Neue Testfälle des Auftrags: je geänderter Testdatei (ohne Playwright) die Namen, die es auf dem Stand vor dem Auftrag
 * nicht gab. Der alte Stand ist `merge-base HEAD <Basis-Branch>` – nicht der Vorgänger eines einzelnen Commits, denn
 * ein Auftrag hat oft mehrere Commits (je Agent, WIP, nachgezogene Basis).
 */
export async function findNewTestCases(
  cwd: string,
  baseBranch: string,
  changed: readonly string[],
  execute: CommandExecutor,
): Promise<{ base: string; targets: ProbeTarget[] }> {
  const { git, must } = gitHelpers(execute, cwd);
  const base = await must('merge-base', 'HEAD', baseBranch);
  const targets: ProbeTarget[] = [];
  for (const file of counterCheckFiles([...changed])) {
    const content = await readFile(join(cwd, file), 'utf8').catch(() => null);
    if (content === null || isPlaywrightTest(file, content)) continue;
    const old = await git('show', `${base}:${file}`);
    const names = newTestCases(old.exitCode === 0 ? old.output : null, content);
    if (names.length) targets.push({ file, names, content });
  }
  return { base, targets };
}

/** Entfernt eigene Worktrees, die ein harter Abbruch hinterlassen hat (älter als zwei Stunden oder Ordner fehlt). */
export async function pruneStaleProbes(cwd: string, execute: CommandExecutor, now = Date.now()): Promise<void> {
  const { git } = gitHelpers(execute, cwd);
  const list = await git('worktree', 'list', '--porcelain');
  for (const line of list.exitCode === 0 ? list.output.split('\n') : []) {
    const path = line.startsWith('worktree ') ? line.slice('worktree '.length).trim() : '';
    if (!path || !basename(path).startsWith(COUNTER_PROBE_PREFIX)) continue;
    const changed = await stat(path).then(
      (info) => info.mtimeMs,
      () => 0,
    );
    if (now - changed < STALE_MS) continue;
    await git('worktree', 'remove', '--force', path);
    await rm(path, { recursive: true, force: true }).catch(() => undefined);
  }
  await git('worktree', 'prune');
}

export interface ProbeOptions {
  /** Arbeitsordner des Auftrags (Agent-Worktree) auf dem Auftrags-Branch. */
  cwd: string;
  /** Basis-Branch des Auftrags (Sprint-Branch oder main). */
  baseBranch: string;
  changedFiles: readonly string[];
  /** Testbefehle je Auftrag; nur die mit `{tests}` laufen. */
  commands: readonly string[][];
  /** Git auf dem Host. */
  execute: CommandExecutor;
  /** Executor für die Testbefehle im Worktree: Testcontainer der Sandbox wie beim Test-Gate. */
  testExecutor: (folder: string) => Promise<CommandExecutor>;
  /** node_modules verlinken (nur ohne Sandbox; im Container liefert das Volume sie). */
  linkModules?: boolean;
  commandTimeoutMs?: number;
  budgetMs?: number;
}

const emptyCheck = (base: string | null): CounterCheck => ({
  checkedAt: new Date().toISOString(),
  base,
  commit: null,
  files: [],
  cases: [],
});

/** Führt die Testfälle je Datei aus; bestandene einmal wiederholt, damit ein wackliger Test keinen Fehlalarm auslöst. */
async function runTargets(
  worktree: string,
  targets: readonly ProbeTarget[],
  commands: readonly string[][],
  execute: CommandExecutor,
  options: { timeoutMs: number; deadline: number },
): Promise<CounterProbeCase[]> {
  const run = async (target: ProbeTarget, names: string[]): Promise<CounterProbeCase[]> => {
    const filtered = commands.map((command) => withNameFilter(command, names));
    const planned = expandOrderCommands(filtered, [target.file], [target.file], () => false).filter(
      (entry) => !entry.skipped,
    );
    if (!planned.length)
      return classifyCases(target.file, names, problemRun('Kein Testbefehl mit {tests} für diese Datei.'));
    let cases: CounterProbeCase[] = [];
    for (const { command } of planned) {
      if (Date.now() >= options.deadline)
        return classifyCases(target.file, names, problemRun('Zeitbudget der Gegenprobe erschöpft.'));
      const result = await runProjectCommand(command, worktree, { timeoutMs: options.timeoutMs }, execute);
      const output = redactOutput(result.output, process.env);
      cases = classifyCases(target.file, names, {
        exitCode: result.exitCode,
        output,
        problem: commandProblem(result, result.durationMs >= options.timeoutMs),
      });
      // Ein Befehl, der die Fälle auswerten konnte, reicht; weitere Befehle (anderer Runner) nur, wenn er es nicht konnte.
      if (cases.some((entry) => entry.result !== 'inconclusive')) break;
    }
    return cases;
  };
  const results: CounterProbeCase[] = [];
  for (const target of targets) {
    const first = await run(target, target.names);
    const passing = first.filter((entry) => entry.result === 'passes').map((entry) => entry.name);
    const again = passing.length ? await run(target, passing) : [];
    for (const entry of first) {
      const repeat = again.find((other) => other.name === entry.name);
      results.push(
        entry.result === 'passes' && repeat?.result !== 'passes'
          ? { ...entry, result: 'inconclusive', detail: 'wackelig: bestand einmal, in der Wiederholung nicht' }
          : entry,
      );
    }
  }
  return results;
}

const problemRun = (problem: string): ProbeRun => ({ exitCode: 1, output: '', problem });

/**
 * Gegenprobe eines Bugfixes: Die neuen Testfälle laufen in einem eigenen, losgelösten Worktree auf dem Stand vor dem
 * Auftrag; dort liegen nur die Testdateien aus dem Auftrag. Arbeitsordner, Index, HEAD und Branches bleiben
 * unberührt, der Worktree wird immer entfernt (auch bei Fehlern und Zeitüberschreitung). Wirft nie.
 */
export async function runCounterProbe(options: ProbeOptions): Promise<CounterCheck> {
  const { git, must } = gitHelpers(options.execute, options.cwd);
  let check = emptyCheck(null);
  let worktree: string | null = null;
  try {
    const found = await findNewTestCases(options.cwd, options.baseBranch, options.changedFiles, options.execute);
    check = { ...emptyCheck(found.base), commit: await must('rev-parse', 'HEAD') };
    if (!found.targets.length) {
      return {
        ...check,
        verdict: 'none',
        reason: 'Keine neuen Testfälle (test/it) im Diff des Auftrags – keine Gegenprobe.',
      };
    }
    const runnable = options.commands.filter((command) => command.includes(TESTS_PLACEHOLDER));
    if (!runnable.length) {
      const reason = 'Keine Testbefehle je Auftrag mit {tests} hinterlegt – Gegenprobe nicht möglich.';
      const cases = found.targets.flatMap((target) => classifyCases(target.file, target.names, problemRun(reason)));
      return { ...check, cases, verdict: probeVerdict(cases), reason };
    }
    await pruneStaleProbes(options.cwd, options.execute);
    worktree = await mkdtemp(join(tmpdir(), COUNTER_PROBE_PREFIX));
    // Losgelöst: Den Basis-Branch hat womöglich ein anderer Worktree ausgecheckt.
    await must('worktree', 'add', '--detach', worktree, found.base);
    for (const target of found.targets) {
      const path = join(worktree, target.file);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, target.content);
    }
    if (options.linkModules) {
      try {
        linkDependencies(options.cwd, worktree);
      } catch {
        // Ohne Abhängigkeiten scheitern die Tests beim Laden – das ergibt „nicht auswertbar“, keinen Beleg.
      }
    }
    const execute = await options.testExecutor(worktree);
    const cases = await runTargets(worktree, found.targets, runnable, execute, {
      timeoutMs: options.commandTimeoutMs ?? COMMAND_TIMEOUT_MS,
      deadline: Date.now() + (options.budgetMs ?? PROBE_BUDGET_MS),
    });
    return { ...check, cases, verdict: probeVerdict(cases) };
  } catch (error) {
    const reason = shortDetail(error instanceof Error ? error.message : String(error));
    return {
      ...check,
      verdict: check.cases?.length ? probeVerdict(check.cases) : 'inconclusive',
      error: reason,
      reason,
    };
  } finally {
    if (worktree) {
      await git('worktree', 'remove', '--force', worktree).catch(() => undefined);
      await rm(worktree, { recursive: true, force: true }).catch(() => undefined);
      await git('worktree', 'prune').catch(() => undefined);
    }
  }
}

const cell = (text: string): string => text.replace(/\|/g, '\\|').replace(/\s+/g, ' ');

/** Abschnitt „Gegenprobe“ für den Testbericht und die Ausgabe des Tester-Schritts. */
export function counterProbeSection(check: CounterCheck): string {
  const lines = ['## Gegenprobe', ''];
  const cases = check.cases ?? [];
  if (check.verdict === 'none' || !cases.length) {
    lines.push(check.reason ?? 'Keine Gegenprobe gelaufen.');
    return `${lines.join('\n')}\n`;
  }
  lines.push(
    `Neue Testfälle des Bugfixes, ausgeführt auf dem Stand vor dem Auftrag${check.base ? ` (\`${check.base.slice(0, 7)}\`)` : ''}. Erwartet ist „${COUNTER_PROBE_LABELS.fails}“.`,
    '',
    '| Testfall | Datei | Ergebnis auf dem alten Stand |',
    '| --- | --- | --- |',
    ...cases.map(
      (entry) =>
        `| ${cell(entry.name)} | \`${entry.file}\` | **${COUNTER_PROBE_LABELS[entry.result]}**${entry.detail ? ` – ${cell(entry.detail)}` : ''} |`,
    ),
    '',
  );
  if (check.verdict === 'unproven') {
    lines.push(
      `**${UNPROVEN_FIX_MARK}:** Mindestens ein neuer Testfall besteht auch ohne den Fix. Bitte den Test so schreiben, dass er den Fehler auf dem alten Stand zeigt.`,
    );
  } else if (check.verdict === 'proven') {
    lines.push('**Fix belegt:** Alle neuen Testfälle scheitern ohne den Fix.');
  } else {
    lines.push(
      `**Nicht auswertbar:** Nicht jeder neue Testfall liess sich auf dem alten Stand bewerten – das ist weder Beleg noch Rückgabegrund.${check.reason ? ` ${check.reason}` : ''}`,
    );
  }
  return `${lines.join('\n')}\n`;
}

const two = (value: number): string => String(value).padStart(2, '0');

/** Ersetzt einen vorhandenen Abschnitt „## Gegenprobe“ (bis zur nächsten Überschrift zweiter Ebene) oder hängt ihn an. */
export function withProbeSection(report: string, section: string): string {
  const start = report.search(/^## Gegenprobe\s*$/m);
  if (start < 0) return `${report.trimEnd()}\n\n${section}`;
  const rest = report.slice(start + 1);
  const next = rest.search(/^## /m);
  const end = next < 0 ? report.length : start + 1 + next;
  return `${report.slice(0, start)}${section}${next < 0 ? '' : `\n${report.slice(end)}`}`;
}

/**
 * Schreibt den Abschnitt in den Testbericht des Schritts: in den jüngsten `docs/tests/<Lauf>/bericht.md`, der seit
 * Schrittbeginn entstand (test:full oder Tester); gibt es keinen (test-agent schreibt keinen), einen eigenen Lauf-Ordner.
 * Liefert den Pfad relativ zum Arbeitsordner.
 */
export async function writeProbeReport(cwd: string, section: string, since: number, now = new Date()): Promise<string> {
  const root = join(cwd, 'docs', 'tests');
  const entries = existsSync(root) ? await readdir(root, { withFileTypes: true }) : [];
  let newest: { path: string; time: number } | null = null;
  for (const entry of entries.filter((item) => item.isDirectory())) {
    const path = join(root, entry.name, 'bericht.md');
    const time = await stat(path).then(
      (info) => info.mtimeMs,
      () => -1,
    );
    if (time >= since && (!newest || time > newest.time)) newest = { path, time };
  }
  if (newest) {
    await writeFile(newest.path, withProbeSection(await readFile(newest.path, 'utf8'), section));
    return newest.path.slice(cwd.length + 1);
  }
  const stamp = `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}_${two(now.getHours())}-${two(now.getMinutes())}`;
  const path = join(root, `${stamp}_gegenprobe`, 'bericht.md');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `# Testbericht: Gegenprobe\n\n${section}`);
  return path.slice(cwd.length + 1);
}

export interface BugfixProbeOutcome {
  check: CounterCheck;
  section: string;
  /** Mindestens ein neuer Testfall besteht ohne Fix: Auftrag geht über den Weg roter Tests zurück an den Entwickler. */
  unproven: boolean;
  report: string | null;
}

/**
 * Gegenprobe im Tester-Schritt eines Bugfix-Auftrags: ausführen, am Auftrag speichern (überschreibt die Markierung
 * eines früheren Versuchs) und in den Testbericht schreiben. Speichern oder Bericht dürfen das Ergebnis nicht kippen.
 */
export async function probeBugfixOrder(options: {
  pool: Pool;
  item: { id: string; projectSlug: string };
  cwd: string;
  baseBranch: string;
  changedFiles: readonly string[];
  execute: CommandExecutor;
  testExecutor: (folder: string) => Promise<CommandExecutor>;
  linkModules: boolean;
  stepStartedAt: number;
}): Promise<BugfixProbeOutcome> {
  const commands = (await loadOrderTestCommands(options.pool, options.item.projectSlug).catch(() => null)) ?? [];
  const check = await runCounterProbe({ ...options, commands });
  const section = counterProbeSection(check);
  await saveCounterCheck(options.pool, options.item.id, check).catch((error: unknown) =>
    console.error(`[${options.item.id}] Gegenprobe nicht gespeichert:`, error),
  );
  const report = await writeProbeReport(options.cwd, section, options.stepStartedAt).catch((error: unknown) => {
    console.error(`[${options.item.id}] Gegenprobe nicht im Testbericht:`, error);
    return null;
  });
  return { check, section, unproven: check.verdict === 'unproven', report };
}
