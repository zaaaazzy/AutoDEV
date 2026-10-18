import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CommandExecutor } from '../core/command.js';
import type { CoverageArea, CoverageReport } from './coverage.js';

/**
 * Eigene Abdeckungsmessung von Dev Log: Für Testbefehle, deren npm-Skript den Node-Test-Runner nutzt
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
  for (const [pattern, label] of [
    [/backend|server|api/i, 'Backend'],
    [/frontend|web|ui|client/i, 'Frontend'],
    [/contract|shared|common/i, 'Contracts'],
  ] as const) {
    if (pattern.test(name)) return label;
  }
  return name || 'Projekt';
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
): Promise<CoverageArea[]> {
  const areas: CoverageArea[] = [];
  for (const command of commands) {
    if (command[0] !== 'npm' || command[1] !== 'test') continue;
    const workspace = command.find((part) => part.startsWith('--workspace='))?.slice('--workspace='.length);
    const dir = workspace ? await workspaceDir(cwd, workspace) : cwd;
    if (!dir) continue;
    const script = (await packageJson(dir))?.scripts?.test?.trim() ?? '';
    const runner = RUNNER.exec(script);
    if (!runner) continue;
    const result = await execute(
      [
        'npm',
        'exec',
        '--',
        runner[1]!,
        '--test',
        '--experimental-test-coverage',
        '--test-coverage-exclude=**/*.test.ts',
        '--test-coverage-exclude=**/*.test.js',
        '--test-coverage-exclude=**/node_modules/**',
        ...splitArgs(runner[2] ?? ''),
      ],
      dir,
      { timeoutMs: TIMEOUT_MS },
    ).catch(() => null);
    const measured = result && parseNodeCoverage(result.output);
    if (!measured) continue;
    areas.push({
      area: areaName(workspace ?? (await packageJson(dir))?.name ?? 'Projekt'),
      unit: measured.passed + measured.failed,
      component: 0,
      integration: 0,
      e2e: 0,
      statements: null,
      ...measured,
    });
  }
  return areas;
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
  const note = `**Gemessen von Dev Log:** ${measured
    .map(
      (area) => `${area.area} ${area.lines} % Zeilen, ${area.branches} % Verzweigungen, ${area.functions} % Funktionen`,
    )
    .join(' · ')}`;
  return { summary: report?.summary ? `${report.summary}\n\n${note}` : note, areas };
}
