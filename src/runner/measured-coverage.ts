import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CommandExecutor } from '../core/command.js';
import type { CoverageArea, CoverageReport } from './coverage.js';
import { runProjectCommand } from './project-command.js';
import { defined } from '../core/defined.js';

/**
 * Eigene Abdeckungsmessung von AIdeation: Für Testbefehle, deren npm-Skript den Node-Test-Runner nutzt
 * (`tsx --test …` bzw. `node --test …`), startet der Worker denselben Lauf mit `--experimental-test-coverage`.
 * So gibt es Prozentwerte, auch wenn der Tester selbst nicht messen durfte oder konnte.
 */
const RUNNER = /^(tsx|node)\s+--test\b(.*)$/;
const TIMEOUT_MS = 5 * 60 * 1000;

/** Zerlegt einfache Shell-Argumente (Anführungszeichen, keine Variablen). */
export function splitArgs(text: string): string[] {
  return [...text.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((match) => match[1] ?? match[2] ?? match[3] ?? '');
}

/** Liest „all files“ und die Testzahlen aus der Ausgabe des Node-Test-Runners. */
export function parseNodeCoverage(
  output: string,
): Pick<CoverageArea, 'lines' | 'branches' | 'functions' | 'passed' | 'failed'> | null {
  const total = /^#?\s*all files\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)/m.exec(output);
  if (!total) return null;
  const number = (pattern: RegExp) => Number(pattern.exec(output)?.[1] ?? 0);
  return {
    lines: Number(total[1]),
    branches: Number(total[2]),
    functions: Number(total[3]),
    passed: number(/^# pass (\d+)/m),
    failed: number(/^# fail (\d+)/m),
  };
}

/** Lesbarer Bereichsname aus dem Workspace-Namen („mainty-backend“ → „Backend“). */
export function areaName(workspace: string): string {
  const name = workspace.replace(/^@[^/]+\//, '');
  // Nur ganze Namensteile (getrennt durch -, _, / usw.): „builder“ ist kein „ui“, „rapid“ keine „api“.
  const word = (words: string) => new RegExp(`(?:^|[^a-z0-9])(?:${words})s?(?=$|[^a-z0-9])`, 'i');
  for (const [pattern, label] of [
    [word('backend|server|api'), 'Backend'],
    [word('frontend|web|ui|client'), 'Frontend'],
    [word('contract|shared|common'), 'Contracts'],
  ] as const) {
    if (pattern.test(name)) return label;
  }
  return name || 'Projekt';
}

export interface TestRunner {
  /** `tsx` oder `node`. */
  binary: string;
  /** Argumente nach `--test` (Dateimuster usw.). */
  args: string[];
  /** Befehle, die im Skript vor dem Testlauf stehen (z. B. `npm run build:ui`); laufen vorher. */
  setup: string[][];
}

const MAX_SCRIPT_DEPTH = 3;

/**
 * Vorbereitende Schritte, die die Messung selbst startet: nur npm-Skripte und bekannte Build-Werkzeuge. Beliebige
 * Befehle aus dem `test`-Skript (`node -e …`, `curl …`, `sh -c …`) führt AIdeation nicht aus.
 */
const SETUP_COMMANDS: ((step: string[]) => boolean)[] = [
  (step) => step[0] === 'npm' && (step[1] === 'run' || step[1] === 'run-script') && /^[\w:.-]+$/.test(step[2] ?? ''),
  (step) => step[0] === 'npm' && step[1] === 'ci' && step.length === 2,
  (step) => step[0] === 'tsc',
  (step) => step[0] === 'ng' && step[1] === 'build',
  (step) => step[0] === 'vite' && step[1] === 'build',
];

export function allowedSetupStep(step: string[]): boolean {
  // Keine Shell-Zeichen: Die Schritte laufen ohne Shell; Verkettungen oder Ersetzungen gehören nicht hinein.
  if (step.some((part) => /[;|&<>`$()]/.test(part))) return false;
  return SETUP_COMMANDS.some((allowed) => allowed(step));
}

/**
 * Findet den Node-Test-Runner in einem npm-Skript: auch hinter `&&` (z. B. `npm run build:ui && tsx --test …`)
 * und über `npm run <name>` in anderen Skripten (höchstens ein paar Ebenen tief). Null, wenn keiner vorkommt.
 */
export function testRunnerOf(script: string, scripts: Record<string, string>, depth = 0): TestRunner | null {
  const parts = script
    .split('&&')
    .map((part) => part.trim())
    .filter(Boolean);
  for (const [index, part] of parts.entries()) {
    const setup = parts.slice(0, index).map(splitArgs);
    const runner = RUNNER.exec(part);
    if (runner) return { binary: runner[1] ?? 'tsx', args: splitArgs(runner[2] ?? ''), setup };
    const nested = /^npm\s+run\s+([\w:.-]+)$/.exec(part)?.[1];
    if (nested && depth < MAX_SCRIPT_DEPTH && scripts[nested]) {
      const inner = testRunnerOf(scripts[nested], scripts, depth + 1);
      if (inner) return { ...inner, setup: [...setup, ...inner.setup] };
    }
  }
  return null;
}

async function packageJson(
  dir: string,
): Promise<{ name?: string; workspaces?: string[]; scripts?: Record<string, string> } | null> {
  try {
    return JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
}

/** Ordner eines npm-Workspaces anhand seines Namens (oder Ordnernamens). */
async function workspaceDir(cwd: string, name: string): Promise<string | null> {
  const root = await packageJson(cwd);
  for (const entry of root?.workspaces ?? []) {
    if (entry.includes('*')) continue;
    const dir = join(cwd, entry);
    const pkg = await packageJson(dir);
    if (pkg?.name === name || entry.split('/').pop() === name) return dir;
  }
  return null;
}

export async function measureCoverage(
  cwd: string,
  commands: string[][],
  execute: CommandExecutor,
  /** Abgelehnte Vorbereitungsschritte: der Aufrufer zeigt sie im Schritt, nicht nur im Worker-Log. */
  onRefused?: (message: string) => void,
): Promise<CoverageArea[]> {
  const areas: CoverageArea[] = [];
  for (const command of commands) {
    // Testplan je Auftrag: „npx tsx --test <Dateien>“ direkt mit Abdeckung wiederholen (kein Skript, kein Setup).
    const direct = directRunner(command);
    if (direct) {
      const measured = await coverageRun(cwd, direct, execute);
      if (measured) areas.push(coverageArea(areaName((await packageJson(cwd))?.name ?? 'Projekt'), measured));
      continue;
    }
    if (command[0] !== 'npm' || command[1] !== 'test') continue;
    const workspace = command.find((part) => part.startsWith('--workspace='))?.slice('--workspace='.length);
    const dir = workspace ? await workspaceDir(cwd, workspace) : cwd;
    if (!dir) continue;
    const scripts = (await packageJson(dir))?.scripts ?? {};
    const runner = testRunnerOf(scripts.test?.trim() ?? '', scripts);
    if (!runner) {
      console.warn(`[coverage] Abdeckung nicht messbar: Testskript in ${dir} nicht erkannt (kein tsx/node --test).`);
      continue;
    }
    const refused = runner.setup.find((step) => !allowedSetupStep(step));
    if (refused) {
      const message = `Abdeckung nicht gemessen: Vorbereitungsschritt „${refused.join(' ')}“ im test-Skript (${dir}) ist nicht erlaubt (nur npm run, npm ci, tsc, ng build, vite build).`;
      console.warn(`[coverage] ${message}`);
      onRefused?.(message);
      continue;
    }
    // Vorbereitende Schritte des Skripts (z. B. Oberfläche bauen) wie beim normalen Testlauf zuerst ausführen.
    let prepared = true;
    for (const step of runner.setup) {
      const done = await runProjectCommand(step, dir, { timeoutMs: TIMEOUT_MS }, execute).catch(() => null);
      if (done?.exitCode !== 0) prepared = false;
    }
    if (!prepared) continue;
    const measured = await coverageRun(dir, runner, execute);
    if (!measured) continue;
    areas.push(coverageArea(areaName(workspace ?? (await packageJson(dir))?.name ?? 'Projekt'), measured));
  }
  return areas;
}

const COVERAGE_FLAG = '--experimental-test-coverage';

/** Wrapper vor dem Testläufer, die die Messung übernehmen darf (`npx`, `npx --no-install`, `npm exec --`). */
const RUNNER_PREFIXES = new Set(['', 'npx', 'npx --no-install', 'npm exec --', 'npm exec --no-install --']);

/** Direkter Aufruf des Node-Test-Runners (`npx tsx --test a.test.ts`, `node --test …`), sonst null. */
export function directRunner(command: string[]): Pick<TestRunner, 'binary' | 'args'> | null {
  const index = command.findIndex((part, position) => /^(tsx|node)$/.test(part) && command[position + 1] === '--test');
  if (index < 0 || !RUNNER_PREFIXES.has(command.slice(0, index).join(' '))) return null;
  const args = command.slice(index + 2).filter((part) => !part.startsWith('--test-coverage') && part !== COVERAGE_FLAG);
  return { binary: defined(command[index]), args };
}

/** Startet den Testläufer mit Abdeckung (gefiltertes Environment) und liest das Ergebnis. */
async function coverageRun(
  dir: string,
  runner: Pick<TestRunner, 'binary' | 'args'>,
  execute: CommandExecutor,
): Promise<ReturnType<typeof parseNodeCoverage>> {
  const result = await runProjectCommand(
    [
      'npm',
      'exec',
      '--',
      runner.binary,
      '--test',
      COVERAGE_FLAG,
      '--test-coverage-exclude=**/*.test.ts',
      '--test-coverage-exclude=**/*.test.js',
      '--test-coverage-exclude=**/*.spec.ts',
      '--test-coverage-exclude=**/node_modules/**',
      ...runner.args,
    ],
    dir,
    { timeoutMs: TIMEOUT_MS },
    execute,
  ).catch(() => null);
  return result && parseNodeCoverage(result.output);
}

function coverageArea(area: string, measured: NonNullable<ReturnType<typeof parseNodeCoverage>>): CoverageArea {
  return {
    area,
    unit: measured.passed + measured.failed,
    component: 0,
    integration: 0,
    e2e: 0,
    statements: null,
    ...measured,
  };
}

/** Ergänzt den Bericht des Testers um die gemessenen Werte (gemessene Prozente haben Vorrang). */
export function mergeCoverage(report: CoverageReport | null, measured: CoverageArea[]): CoverageReport | null {
  if (!measured.length) return report;
  const areas = [...(report?.areas ?? [])];
  for (const entry of measured) {
    const existing = areas.find((area) => area.area.toLowerCase() === entry.area.toLowerCase());
    if (existing) {
      Object.assign(existing, {
        lines: entry.lines,
        branches: entry.branches,
        functions: entry.functions,
        passed: existing.passed || entry.passed,
        failed: existing.failed || entry.failed,
        unit: existing.unit + existing.component + existing.integration + existing.e2e ? existing.unit : entry.unit,
      });
    } else areas.push(entry);
  }
  const note = `**Gemessen von AIdeation:** ${measured
    .map(
      (area) => `${area.area} ${area.lines} % Zeilen, ${area.branches} % Verzweigungen, ${area.functions} % Funktionen`,
    )
    .join(' · ')}`;
  return { summary: report?.summary ? `${report.summary}\n\n${note}` : note, areas };
}
