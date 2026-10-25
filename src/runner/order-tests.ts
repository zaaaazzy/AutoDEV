import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { loadOrderTestCommands, loadTestCommands } from './runner-selection.js';

/**
 * Tests im Tester-Schritt eines Auftrags: nur zu den Dateien, die der Auftrag geändert hat. Die vollständigen
 * Testbefehle des Projekts (test_commands) laufen nur noch beim Live schalten (Test-Gate in git-sync).
 */

/** Platzhalter in den Testbefehlen je Auftrag: zugehörige Testdateien bzw. geänderte Dateien (je ein Argument). */
export const TESTS_PLACEHOLDER = '{tests}';
export const FILES_PLACEHOLDER = '{files}';
export const SKIPPED_NOTE = 'übersprungen – keine passenden Tests zu den geänderten Dateien';

const TEST_FILE = /\.(?:test|spec)\.(?:ts|mjs|js)$/;
/** Endungen, zu denen Geschwister-Tests gesucht werden (x.component.html → x.component.spec.ts). */
const SOURCE_FILE = /^(.+)\.(?:ts|tsx|mts|cts|js|mjs|cjs|html|css|scss)$/;
const TEST_SUFFIXES = ['.test.ts', '.spec.ts', '.test.mjs', '.spec.mjs', '.test.js'];

export function isTestFile(path: string): boolean {
  return TEST_FILE.test(path);
}

/**
 * Testdateien zu geänderten Dateien: geänderte Testdateien selbst (sofern noch vorhanden) und Tests mit demselben
 * Grundnamen daneben (`x.ts` → `x.test.ts`/`x.spec.ts`, `x.component.html` → `x.component.spec.ts`,
 * `x.mjs` → `x.test.mjs`). Sortiert und ohne Doppelte.
 */
export function relatedTestFiles(changed: string[], exists: (path: string) => boolean): string[] {
  const found = new Set<string>();
  for (const path of changed) {
    if (isTestFile(path)) {
      if (exists(path)) found.add(path);
      continue;
    }
    const stem = SOURCE_FILE.exec(path)?.[1];
    if (!stem) continue;
    for (const suffix of TEST_SUFFIXES) {
      if (exists(`${stem}${suffix}`)) found.add(`${stem}${suffix}`);
    }
  }
  return [...found].sort();
}

const PLAYWRIGHT_IMPORT = /from\s+['"]@playwright\/test['"]|require\(\s*['"]@playwright\/test['"]\s*\)/;

/** Playwright-Test: liegt unter e2e/ oder importiert @playwright/test (Inhalt fehlt → nur der Pfad zählt). */
export function isPlaywrightTest(path: string, content?: string): boolean {
  return /(?:^|\/)e2e\//.test(path) || (content !== undefined && PLAYWRIGHT_IMPORT.test(content));
}

/** Befehl startet Playwright (`npx playwright test …`, `node_modules/.bin/playwright …`). */
function runsPlaywright(command: string[]): boolean {
  return command.some((part) => /(?:^|\/)playwright$/.test(part));
}

export interface PlannedCommand {
  command: string[];
  /** Ein Platzhalter ergab keine Datei: Befehl wird nicht ausgeführt. */
  skipped: boolean;
}

/**
 * Setzt `{tests}` und `{files}` ein (je Datei ein Argument). Ein Befehl, dessen Platzhalter leer bleibt, wird
 * übersprungen; Befehle ohne Platzhalter laufen immer. `{tests}` bekommt je Runner nur seine Dateien:
 * Playwright-Befehle nur Playwright-Tests, alle anderen (Vitest, node --test, …) keine – sonst meldet etwa
 * `vitest run e2e/x.spec.ts` „No test files found“ und der Schritt wird rot, ohne dass am Code etwas falsch ist.
 */
export function expandOrderCommands(
  commands: string[][],
  files: string[],
  tests: string[],
  isPlaywright: (path: string) => boolean = (path) => isPlaywrightTest(path),
): PlannedCommand[] {
  return commands.map((command) => {
    let skipped = false;
    const playwright = runsPlaywright(command);
    const runnerTests = tests.filter((path) => isPlaywright(path) === playwright);
    const expanded = command.flatMap((part) => {
      const values = part === TESTS_PLACEHOLDER ? runnerTests : part === FILES_PLACEHOLDER ? files : null;
      if (!values) return [part];
      if (!values.length) skipped = true;
      return values;
    });
    return { command: skipped ? command : expanded, skipped };
  });
}

export interface TesterPlan {
  commands: PlannedCommand[];
  /** Testbefehle je Auftrag mit den geänderten Dateien (false = wie bisher die Testbefehle des Projekts). */
  scoped: boolean;
  files: string[];
  tests: string[];
}

/**
 * Befehle für den Tester-Schritt: die Testbefehle je Auftrag, eingeschränkt auf die geänderten Dateien. Ohne
 * Testbefehle je Auftrag oder ohne bekannte Änderungen (Projekt ohne Git) gelten die Testbefehle des Projekts.
 */
export async function testerPlan(
  pool: Pool,
  project: string,
  cwd: string,
  changed: string[] | undefined,
): Promise<TesterPlan> {
  const order = changed ? await loadOrderTestCommands(pool, project) : null;
  if (!order || !changed) {
    const commands = await loadTestCommands(pool, project);
    return { commands: commands.map((command) => ({ command, skipped: false })), scoped: false, files: [], tests: [] };
  }
  const exists = (path: string): boolean => existsSync(join(cwd, path));
  const files = changed.filter(exists);
  const tests = relatedTestFiles(changed, exists);
  const isPlaywright = (path: string): boolean => {
    try {
      return isPlaywrightTest(path, readFileSync(join(cwd, path), 'utf8'));
    } catch {
      return isPlaywrightTest(path);
    }
  };
  return { commands: expandOrderCommands(order, files, tests, isPlaywright), scoped: true, files, tests };
}

/** Kurzer Hinweis über den Umfang des Testlaufs für die Ausgabe des Tester-Schritts. */
export function planSummary(plan: TesterPlan): string {
  if (!plan.scoped) return '';
  const tests = plan.tests.length ? plan.tests.map((path) => `- ${path}`).join('\n') : '- keine';
  const lines = [
    `Tests beschränkt auf die ${plan.files.length} geänderte(n) Datei(en) des Auftrags (Testbefehle je Auftrag).`,
    `Zugehörige Testdateien:\n${tests}`,
  ];
  if (plan.commands.every((command) => command.skipped)) {
    lines.push('Alle Testbefehle übersprungen: keine passenden Tests zu den geänderten Dateien – Schritt bestanden.');
  }
  return lines.join('\n');
}
