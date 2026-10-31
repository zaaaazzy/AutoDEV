// CI und Test-Gate: GitHub-Actions-Workflow, Warten auf CI-Läufe, Projekttests und maskierte CI-Logs.
import { existsSync } from 'node:fs';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type CommandExecutor, redactOutput } from '../../core/command.js';
import { GIT_TIMEOUT_MS, type GitHelpers, SECRET_CONTENT } from './git-helpers.js';
import { gitEnvironment, runProjectCommand } from '../project-command.js';
import { defined } from '../../core/defined.js';

// Projekttests können den kompletten Oberflächentest mit Playwright enthalten (Desktop und Handy).
export const TEST_TIMEOUT_MS = 45 * 60_000;

const CI_WORKFLOW = join('.github', 'workflows', 'devlog-ci.yml');
const CI_WAIT_MS = 30 * 60_000;

const shellArg = (part: string): string => (/^[\w@%+=:,./-]+$/.test(part) ? part : `'${part.replace(/'/g, `'\\''`)}'`);

/** GitHub-Actions-Workflow: dieselben Testbefehle wie das lokale Test-Gate, bei Push und Pull Request. */
export function ciWorkflowYaml(
  commands: string[][],
  options: { node: boolean; lockfile: boolean; python: boolean },
): string {
  const steps = [
    '      - uses: actions/checkout@v4',
    ...(options.node
      ? [
          '      - uses: actions/setup-node@v4',
          '        with:',
          "          node-version-file: '.nvmrc'",
          ...(options.lockfile ? ["          cache: 'npm'"] : []),
          `      - run: ${options.lockfile ? 'npm ci' : 'npm install'}`,
        ]
      : []),
    ...(options.python
      ? [
          '      - uses: actions/setup-python@v5',
          '        with:',
          "          python-version: '3.12'",
          '      - run: pip install -r requirements.txt',
        ]
      : []),
    ...commands.map((command) => `      - run: ${command.map(shellArg).join(' ')}`),
  ];
  return `# Automatisch von AIdeation angelegt: Build und Tests als Quality Gate für Pull Requests und main.
name: CI
on:
  push:
    branches: [main, 'sprint/**']
  pull_request:
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
${steps.join('\n')}
`;
}

/** Legt den CI-Workflow an, falls das Projekt nach GitHub pusht und noch keinen Workflow hat. */
export async function ensureCiWorkflow(
  cwd: string,
  commands: string[][],
  helpers: GitHelpers,
  log: string[],
): Promise<void> {
  const directory = join(cwd, '.github', 'workflows');
  const existing = existsSync(directory) ? (await readdir(directory)).filter((file) => /\.ya?ml$/.test(file)) : [];
  if (existing.length || !commands.length) return;
  const node = existsSync(join(cwd, 'package.json'));
  if (node && !existsSync(join(cwd, '.nvmrc'))) await writeFile(join(cwd, '.nvmrc'), '22\n');
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(cwd, CI_WORKFLOW),
    ciWorkflowYaml(commands, {
      node,
      lockfile: existsSync(join(cwd, 'package-lock.json')),
      python: existsSync(join(cwd, 'requirements.txt')),
    }),
  );
  await helpers.must('add', CI_WORKFLOW, ...(node ? ['.nvmrc'] : []));
  await helpers.must(
    'commit',
    '--no-verify',
    '-m',
    'ci: GitHub-Actions-Workflow für Build und Tests',
    '-m',
    'Automatisch angelegt vom AIdeation.',
  );
  log.push('CI-Workflow (GitHub Actions) angelegt.');
}

/** Status und Ergebnis eines GitHub-Actions-Laufs aus `gh run view --json status,conclusion`. */
export function parseRunState(output: string): { status: string; conclusion: string } | null {
  const json = /\{[^{}]*\}/.exec(output);
  if (!json) return null;
  try {
    const value = JSON.parse(json[0]) as { status?: unknown; conclusion?: unknown };
    return typeof value.status === 'string'
      ? { status: value.status, conclusion: typeof value.conclusion === 'string' ? value.conclusion : '' }
      : null;
  } catch {
    return null;
  }
}

/**
 * Wartet auf den GitHub-Actions-Lauf für den gepushten Stand (über die gh CLI). Ohne gh bleibt das lokale Test-Gate
 * maßgeblich; ein roter CI-Lauf verhindert den Merge nach main. Das Urteil kommt aus dem Lauf selbst: `gh run watch`
 * endet bei Netz- oder API-Fehlern auch vorzeitig mit Fehlercode, während der Lauf noch läuft.
 */
export async function waitForCi(
  execute: CommandExecutor,
  cwd: string,
  branch: string,
  log: string[],
  pollMs = 10_000,
): Promise<void> {
  const env = gitEnvironment({ GH_PROMPT_DISABLED: '1' });
  const gh = async (timeoutMs: number, ...args: string[]) => execute(['gh', ...args], cwd, { timeoutMs, env });
  const auth = await gh(GIT_TIMEOUT_MS, 'auth', 'status', '--hostname', 'github.com').catch(() => null);
  if (!auth || auth.exitCode !== 0) {
    log.push('CI-Status nicht prüfbar (GitHub CLI fehlt oder ist nicht angemeldet) – das lokale Test-Gate gilt.');
    return;
  }
  const sha = (await execute(['git', 'rev-parse', 'HEAD'], cwd, { timeoutMs: GIT_TIMEOUT_MS, env })).output.trim();
  let runId = '';
  for (let attempt = 0; attempt < 24 && !runId; attempt += 1) {
    const list = await gh(
      GIT_TIMEOUT_MS,
      'run',
      'list',
      '--branch',
      branch,
      '--commit',
      sha,
      '--limit',
      '1',
      '--json',
      'databaseId',
      '--jq',
      '.[0].databaseId',
    );
    runId = list.exitCode === 0 ? list.output.trim() : '';
    if (!runId) await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  if (!runId) {
    log.push('Kein CI-Lauf gefunden (Workflow fehlt oder GitHub Actions ist aus) – das lokale Test-Gate gilt.');
    return;
  }
  const deadline = Date.now() + CI_WAIT_MS;
  let state: { status: string; conclusion: string } | null;
  let watched = '';
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining > 0) watched = (await gh(remaining, 'run', 'watch', runId)).output;
    state = parseRunState((await gh(GIT_TIMEOUT_MS, 'run', 'view', runId, '--json', 'status,conclusion')).output);
    if (state?.status === 'completed' || Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  if (state?.status !== 'completed') {
    throw new Error(
      `Merge nach main zurückgestellt: CI-Lauf ${runId} auf ${branch} ist nach ${CI_WAIT_MS / 60_000} Minuten noch nicht fertig (Status: ${state?.status ?? 'unbekannt'}).`,
    );
  }
  if (state.conclusion !== 'success') {
    throw new Error(
      `Merge nach main abgelehnt: CI-Lauf ${runId} auf ${branch} ist rot (${state.conclusion || 'ohne Ergebnis'}). ${redactOutput(watched, process.env).slice(-400)}`,
    );
  }
  log.push(`CI grün (Lauf ${runId}).`);
}

/** Zeilen, die einen Befund benennen (Prettier, Playwright, node:test, TypeScript, ESLint-Fehler, Jest/Vitest). */
const FINDING =
  /^\s*(?:\[warn\] |✘|not ok \d|FAIL\b|×|✗)|error TS\d|^\s*\d+:\d+\s+error\b|Error: expect\(|^\s*Error: |Test timeout of/;
/** Zusammenfassungen ohne Befund, die trotzdem wie einer aussehen (z. B. „0 errors“, „0 failed“). */
const NO_FINDING = /\(0 errors?\b|\b0 failed\b|# fail 0\b/;
const SUMMARY_LINES = 8;
const SUMMARY_CHARS = 1_000;

/**
 * Kurzfassung eines roten Test-Gates für Meldung und Autopilot-Pause: welche Schritte rot sind (test:full markiert sie
 * mit „━━ Name: rot ━━“) und die ersten Befund-Zeilen. Nur wenn nichts davon erkennbar ist, das Ende der Ausgabe –
 * das bestand sonst oft aus bestandenen Tests vom Ende des Laufs und verschwieg die Ursache.
 */
export function gateFailureSummary(output: string): string {
  const red = [...new Set([...output.matchAll(/━━ (.+?): rot ━━/g)].map((match) => defined(match[1]).trim()))];
  const findings = [
    ...new Set(
      output
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => FINDING.test(line) && !NO_FINDING.test(line)),
    ),
  ].slice(0, SUMMARY_LINES);
  if (!red.length && !findings.length) return output.slice(-600);
  const parts = [red.length ? `Rot: ${red.join(', ')}.` : '', findings.join(' | ')].filter(Boolean);
  return parts.join(' ').slice(0, SUMMARY_CHARS);
}

/** Führt die Testbefehle des Projekts aus; wirft mit einer Kurzfassung (rote Schritte, Befunde), sobald einer fehlschlägt. */
export async function runTestGate(
  execute: CommandExecutor,
  cwd: string,
  commands: string[][],
  log: string[],
): Promise<void> {
  for (const command of commands) {
    // Nur mit dem gefilterten Environment: Projekttests sollen weder AIdeation-Zugänge sehen noch vom Projektbereich
    // des Workers abhängen.
    const result = await runProjectCommand(command, cwd, { timeoutMs: TEST_TIMEOUT_MS }, execute);
    if (result.exitCode !== 0) {
      throw new Error(
        `Push abgelehnt: \`${command.join(' ')}\` ist fehlgeschlagen (Exit-Code ${result.exitCode}). ${gateFailureSummary(redactOutput(result.output, process.env))}`,
      );
    }
  }
  log.push(
    commands.length
      ? `Tests grün (${commands.length} Befehl${commands.length === 1 ? '' : 'e'}).`
      : 'Keine Testbefehle hinterlegt.',
  );
}

const CI_LOG_LINES = 60;
const CI_LOG_CHARS = 3_000;
const SECRET_ASSIGNMENT =
  /\b([A-Za-z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY|PRIVATE_KEY)[A-Za-z0-9_]*)(\s*[=:]\s*)("?)[^\s"']{4,}\3/gi;

/** Maskiert Zugangsdaten: Werte geheimer Umgebungsvariablen, bekannte Token-Formate und „TOKEN=…“-Zuweisungen. */
export function maskSecrets(text: string, environment: NodeJS.ProcessEnv = process.env): string {
  let masked = redactOutput(text, environment);
  for (const pattern of SECRET_CONTENT) {
    masked = masked.replace(new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`), '[REDACTED]');
  }
  return masked.replace(SECRET_ASSIGNMENT, '$1$2[REDACTED]');
}

/** Gekürzter, maskierter Auszug aus dem Log eines roten CI-Laufs: die letzten Zeilen, höchstens 3000 Zeichen. */
export function ciLogExcerpt(log: string, environment: NodeJS.ProcessEnv = process.env): string {
  const lines = maskSecrets(log, environment)
    .replace(/\r/g, '')
    .split('\n')
    .filter((line) => line.trim());
  const tail = lines.slice(-CI_LOG_LINES).join('\n');
  // Mit dem Auslassungszeichen höchstens CI_LOG_CHARS Zeichen.
  return tail.length > CI_LOG_CHARS ? `…${tail.slice(-(CI_LOG_CHARS - 1))}` : tail;
}
