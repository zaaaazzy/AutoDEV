import { existsSync } from 'node:fs';
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

export interface PlannedCommand {
  command: string[];
  /** Ein Platzhalter ergab keine Datei: Befehl wird nicht ausgeführt. */
  skipped: boolean;
}

/**
 * Setzt `{tests}` und `{files}` ein (je Datei ein Argument). Ein Befehl, dessen Platzhalter leer bleibt, wird
 * übersprungen; Befehle ohne Platzhalter laufen immer.
 */
export function expandOrderCommands(commands: string[][], files: string[], tests: string[]): PlannedCommand[] {
  return commands.map((command) => {
    let skipped = false;
    const expanded = command.flatMap((part) => {
      const values = part === TESTS_PLACEHOLDER ? tests : part === FILES_PLACEHOLDER ? files : null;
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
  return { commands: expandOrderCommands(order, files, tests), scoped: true, files, tests };
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
