import { execFile as nodeExecFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createDatabasePool, readDatabaseConfig } from '../db/database.js';
import { registerProject } from '../db/project.js';
import { categoryOfCommand, parseTapCases } from '../core/test-results.js';
import { createTestRun, createTestRunStep, finishTestRun, finishTestRunStep, saveTestCases } from '../db/test-runs.js';
import type { Pool } from 'pg';
import { redactOutput, runCommand } from '../core/command.js';
import { killGroup } from '../core/shutdown.js';
import { SKIPPED_NOTE } from './order-tests.js';
import { gitEnvironment, projectEnvironment } from './project-command.js';

const execFile = promisify(nodeExecFile);

export interface TestAgentOptions {
  project: string;
  cwd: string;
  commands: string[][];
  /** Je Befehl: übersprungen (Testbefehle je Auftrag ohne passende Dateien); wird nur als Schritt vermerkt. */
  skipped?: boolean[];
  /** Vom Worker aufgerufen: Projekt nicht neu registrieren (sonst würde der gespeicherte Projektordner überschrieben). */
  existingProject?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  /** Gleich nach dem Anlegen des Testlaufs (vor dem ersten Befehl), damit Aufrufer ihn sofort verknüpfen können. */
  onRunCreated?: (runId: string) => Promise<void>;
}

export function parseTestAgentOptions(args: string[], cwd = process.env.INIT_CWD ?? process.cwd()): TestAgentOptions {
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (key !== '--project' && key !== '--cwd' && key !== '--commands') {
      throw new Error(`Unknown test-agent option: ${key}`);
    }
    const value = args[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for ${key}.`);
    }
    options.set(key, value);
    index += 1;
  }

  const workDirectory = resolve(cwd, options.get('--cwd') ?? '.');
  const projectFromDirectory = basename(workDirectory)
    .toLocaleLowerCase('en-US')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 63);
  const project = options.get('--project') ?? projectFromDirectory;
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(project)) {
    throw new Error('Project must be a lowercase slug containing letters, numbers, and hyphens.');
  }

  let commands: string[][] = [
    ['npm', 'run', 'build'],
    ['npm', 'test'],
  ];
  const commandJson = options.get('--commands');
  if (commandJson) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(commandJson);
    } catch {
      throw new Error('--commands must be a JSON array of argument arrays.');
    }
    if (
      !Array.isArray(parsed) ||
      parsed.length < 1 ||
      parsed.length > 20 ||
      parsed.some(
        (command) =>
          !Array.isArray(command) ||
          command.length < 1 ||
          command.length > 40 ||
          command.some((argument) => typeof argument !== 'string' || argument.length > 500) ||
          typeof command[0] !== 'string' ||
          !command[0],
      )
    ) {
      throw new Error('--commands must contain 1 to 20 non-empty arrays of command arguments.');
    }
    commands = parsed as string[][];
  }

  return { project, cwd: workDirectory, commands };
}

async function getGitValue(cwd: string, argument: string): Promise<string | null> {
  try {
    const { stdout } = await execFile('git', ['rev-parse', argument], { cwd, timeout: 5_000, env: gitEnvironment() });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function getProjectName(cwd: string): Promise<string> {
  try {
    const packageJson = JSON.parse(await readFile(resolve(cwd, 'package.json'), 'utf8')) as { name?: unknown };
    return typeof packageJson.name === 'string' ? packageJson.name : basename(cwd);
  } catch {
    return basename(cwd);
  }
}

const NODE_TEST_RUNNERS = new Set(['tsx', 'node']);
/**
 * Nur echte Importe am Zeilenanfang: Node-Tests, die „from '@playwright/test'“ als Text in einem String enthalten
 * (z. B. test-agent.test.ts), sind keine Playwright-Dateien – sonst liefe „playwright test“ mit „No tests found“.
 */
const PLAYWRIGHT_IMPORT =
  /^\s*(?:import\s[^;'"]*?from\s+|import\s+|(?:const|let|var)\s[^=;]*=\s*(?:await\s+)?(?:require|import)\(\s*)['"]@playwright\/test['"]/m;
const PLAYWRIGHT_CONFIGS = ['playwright.config.ts', 'playwright.config.js', 'playwright.config.mjs'];

/** Nächste Playwright-Konfiguration vom Ordner der Datei aufwärts bis zum Projektordner (relativ zu diesem). */
function playwrightConfig(cwd: string, file: string): string | null {
  for (let dir = dirname(resolve(cwd, file)); ; dir = dirname(dir)) {
    const found = PLAYWRIGHT_CONFIGS.map((name) => resolve(dir, name)).find((path) => existsSync(path));
    if (found) return relative(cwd, found);
    if (dir === cwd || dirname(dir) === dir || !resolve(dir).startsWith(resolve(cwd))) return null;
  }
}

/**
 * Playwright-Dateien gehören nicht in den Node-Testrunner: „tsx --test e2e/app.spec.ts“ scheitert mit „Playwright
 * Test did not expect test.beforeAll() to be called here“. Solche Dateien werden aus tsx/node --test herausgenommen
 * und als eigener Schritt mit „npx playwright test -c <Konfiguration>“ ausgeführt; der Rest bleibt, wie er war.
 */
export async function routePlaywrightSpecs(
  commands: string[][],
  cwd: string,
  skipped: boolean[] = [],
): Promise<{ commands: string[][]; skipped: boolean[] }> {
  const routed: string[][] = [];
  const routedSkipped: boolean[] = [];
  for (const [index, command] of commands.entries()) {
    const runner = command.findIndex((part) => NODE_TEST_RUNNERS.has(basename(part)));
    const isNodeTest = runner >= 0 && command.includes('--test');
    const playwright: string[] = [];
    if (isNodeTest) {
      for (const part of command.slice(runner + 1)) {
        if (part.startsWith('-') || !/\.(?:[cm]?[jt]s)$/.test(part) || part.includes('*')) continue;
        const source = await readFile(resolve(cwd, part), 'utf8').catch(() => '');
        if (PLAYWRIGHT_IMPORT.test(source)) playwright.push(part);
      }
    }
    if (!playwright.length) {
      routed.push(command);
      routedSkipped.push(skipped[index] ?? false);
      continue;
    }
    const rest = command.filter((part) => !playwright.includes(part));
    if (rest.slice(runner + 1).some((part) => !part.startsWith('-'))) {
      routed.push(rest);
      routedSkipped.push(skipped[index] ?? false);
    }
    const byConfig = new Map<string, string[]>();
    for (const file of playwright) {
      const config = playwrightConfig(cwd, file) ?? '';
      byConfig.set(config, [...(byConfig.get(config) ?? []), file]);
    }
    for (const [config, files] of byConfig) {
      routed.push(['npx', 'playwright', 'test', ...(config ? ['-c', config] : []), ...files]);
      routedSkipped.push(skipped[index] ?? false);
    }
  }
  return { commands: routed, skipped: routedSkipped };
}

export async function runTestAgent(options: TestAgentOptions, pool: Pool): Promise<string> {
  options = { ...options, ...(await routePlaywrightSpecs(options.commands, options.cwd, options.skipped)) };
  const branch = await getGitValue(options.cwd, '--abbrev-ref=HEAD');
  const commitSha = await getGitValue(options.cwd, 'HEAD');
  const projectName = await getProjectName(options.cwd);
  const repository = process.env.DEV_LOG_REPOSITORY ?? process.env.GITHUB_REPOSITORY ?? options.cwd;
  if (!options.existingProject) {
    await registerProject(pool, { slug: options.project, name: projectName, repository });
  }
  const runId = await createTestRun(pool, {
    projectSlug: options.project,
    trigger: process.env.GITHUB_ACTIONS === 'true' ? 'ci' : 'manual',
    branch,
    commitSha,
  });
  await options.onRunCreated?.(runId);
  let allPassed = true;

  for (const [position, command] of options.commands.entries()) {
    const label = command.join(' ');
    console.info(`Running test step ${position + 1}/${options.commands.length}: ${label}`);
    await createTestRunStep(pool, {
      runId,
      position,
      command: label,
      output: '',
      category: categoryOfCommand(label),
    });
    if (options.skipped?.[position]) {
      await finishTestRunStep(pool, { runId, position, exitCode: 0, durationMs: 0, output: SKIPPED_NOTE });
      console.info(`SKIP ${label}`);
      continue;
    }
    let pid = 0;
    const abort = (): void => {
      if (pid) killGroup(pid);
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    const result = options.signal?.aborted
      ? { exitCode: 130, durationMs: 0, output: 'Abgebrochen.' }
      : await runCommand(command, options.cwd, {
          timeoutMs: options.timeoutMs,
          // Fail-closed: ohne Vorgabe nie das volle Environment des Workers (DEV_LOG_DATABASE_URL usw.).
          env: options.env ?? projectEnvironment(options.cwd),
          onSpawn: (value) => {
            pid = value;
          },
        });
    options.signal?.removeEventListener('abort', abort);
    const safeOutput = redactOutput(result.output, process.env);
    const passed = result.exitCode === 0;
    await finishTestRunStep(pool, {
      runId,
      position,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      output: safeOutput,
    });
    // Einzeltests aus TAP-Ausgaben (node --test) für die Übersicht der Testläufe
    if (categoryOfCommand(label) === 'unit') await saveTestCases(pool, runId, parseTapCases(safeOutput));
    allPassed &&= passed;
    console.info(`${passed ? 'PASS' : 'FAIL'} ${label} (${result.durationMs} ms)`);
    if (safeOutput.trim()) {
      console.info(safeOutput.slice(-4_000));
    }
  }

  await finishTestRun(pool, runId, allPassed);
  console.info(`Test run ${runId}: ${allPassed ? 'PASSED' : 'FAILED'}`);
  return runId;
}

async function main(): Promise<void> {
  let pool: Pool | undefined;
  try {
    const options = parseTestAgentOptions(process.argv.slice(2));
    pool = await createDatabasePool(readDatabaseConfig());
    const runId = await runTestAgent(options, pool);
    const status = await pool.query<{ status: string }>('SELECT status FROM test_runs WHERE id = $1', [runId]);
    if (status.rows[0]?.status !== 'passed') {
      process.exitCode = 1;
    }
  } finally {
    await pool?.end();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error('Test agent failed:', error);
    process.exitCode = 1;
  });
}
