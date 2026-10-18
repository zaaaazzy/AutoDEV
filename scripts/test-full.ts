/**
 * Kompletter Testlauf mit Bericht: Lint, Formatierung, Typen, Unit-Tests, E2E-Tests und der Oberflächentest
 * (e2e/full-ui.check.ts, mit Video und Screenshots). Schreibt den Bericht nach docs/tests/<Datum_Uhrzeit>/ und,
 * mit --projekt, den Lauf samt Einzeltests, Screenshots und Videos in die Ansicht „Testläufe“ dieses Projekts.
 *
 *   npm run test:full                          alles
 *   npm run test:full -- --projekt devlog      zusätzlich in Dev Log unter Testläufe ablegen
 *   npm run test:full -- --nur-oberflaeche     nur der Oberflächentest (UI muss gebaut sein: npm run build:ui)
 *
 * Datenbank für --projekt: DEV_LOG_DATABASE_URL, sonst die lokale aus docker-compose (127.0.0.1:5433).
 */
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, join, relative } from 'node:path';
import { promisify } from 'node:util';
import type { Pool } from 'pg';
import { redactOutput } from '../src/core/command.js';
import {
  parsePlaywrightCases,
  parseTapCases,
  type CaseCategory,
  type PlaywrightReport,
  type TestCaseResult,
  type TestCategory,
} from '../src/core/test-results.js';
import { createDatabasePool, readDatabaseConfig } from '../src/db/database.js';
import {
  createTestRun,
  createTestRunStep,
  finishTestRun,
  finishTestRunStep,
  saveTestCases,
  saveTestReport,
} from '../src/db/test-runs.js';

const ROOT = join(import.meta.dirname, '..');
const argument = (name: string) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const onlyUi = process.argv.includes('--nur-oberflaeche');
const project = argument('--projekt') ?? process.env.DEV_LOG_TEST_PROJECT;
const started = new Date();
const two = (value: number) => String(value).padStart(2, '0');
const stamp = `${started.getFullYear()}-${two(started.getMonth() + 1)}-${two(started.getDate())}_${two(started.getHours())}-${two(started.getMinutes())}`;
// Rohdaten je Lauf getrennt, damit parallele Läufe sich nicht gegenseitig löschen
const TEMP = join(tmpdir(), `dev-log-test-full-${stamp}`);
const OUT = join(ROOT, 'docs', 'tests', stamp);
const MEDIA = join(OUT, 'media');
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const LOCAL_DATABASE = 'postgresql://devlog:devlog_local_dev@127.0.0.1:5433/dev_log';

type Step = {
  name: string;
  command: string;
  args: string[];
  category: TestCategory;
  summary: (output: string) => string;
  /** Einzeltests aus der Ausgabe bzw. aus dem JSON-Bericht von Playwright. */
  cases?: (output: string) => Promise<TestCaseResult[]>;
};
type StepResult = {
  name: string;
  ok: boolean;
  seconds: number;
  summary: string;
  tail: string;
  cases: TestCaseResult[];
};

const counted = (out: string, keys: string[]) =>
  keys
    .map((key) => new RegExp(`(\\d+) ${key}`).exec(out)?.[0])
    .filter(Boolean)
    .join(', ');

async function playwrightCases(file: string, category: CaseCategory): Promise<TestCaseResult[]> {
  if (!existsSync(file)) return [];
  return parsePlaywrightCases(JSON.parse(await readFile(file, 'utf8')) as PlaywrightReport, category);
}

const E2E_JSON = join(TEMP, 'e2e.json');
const UI_JSON = join(TEMP, 'user.json');
const STEPS: Step[] = [
  {
    name: 'Lint',
    command: 'npm',
    args: ['run', 'lint'],
    category: 'quality',
    summary: (out) => /✖ (\d+ problems? \(\d+ errors?, \d+ warnings?\))/.exec(out)?.[1] ?? 'keine Meldungen',
  },
  {
    name: 'Formatierung',
    command: 'npm',
    args: ['run', 'format:check'],
    category: 'quality',
    summary: (out) => {
      const files = [...out.matchAll(/^\[warn\] (?!Code style)(.+)$/gm)].map((match) => match[1]);
      return files.length ? `nicht formatiert: ${files.join(', ')}` : 'alles formatiert';
    },
  },
  {
    name: 'Typprüfung',
    command: 'npm',
    args: ['run', 'typecheck'],
    category: 'quality',
    summary: () => 'Backend und Oberfläche',
  },
  {
    name: 'Unit-Tests (inkl. UI-Build)',
    command: 'npm',
    args: ['test'],
    category: 'unit',
    summary: (out) => {
      const value = (key: string) => new RegExp(`^# ${key} (\\d+)$`, 'm').exec(out)?.[1];
      const warnings = (out.match(/\[WARNING\]/g) ?? []).length;
      return `${value('pass') ?? '?'} bestanden, ${value('fail') ?? '?'} fehlgeschlagen, ${warnings} Build-Warnungen`;
    },
    cases: async (out) => parseTapCases(out),
  },
  {
    name: 'E2E-Tests',
    command: 'npx',
    args: ['playwright', 'test', '-c', 'e2e/playwright.config.ts', '--reporter=list,json'],
    category: 'e2e',
    summary: (out) => counted(out, ['passed', 'failed', 'flaky', 'skipped']),
    cases: () => playwrightCases(E2E_JSON, 'e2e'),
  },
];
const USER_STEP: Step = {
  name: 'Oberflächentest',
  command: 'npx',
  args: ['playwright', 'test', '-c', 'e2e/full.config.ts'],
  category: 'user',
  summary: (out) => counted(out, ['passed', 'failed', 'skipped']),
  cases: () => playwrightCases(UI_JSON, 'user'),
};

/** Führt einen Befehl aus, zeigt die Ausgabe live und gibt sie gesammelt zurück. */
function run(command: string, args: string[]): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    let output = '';
    const child = spawn(command, args, {
      cwd: ROOT,
      shell: process.platform === 'win32',
      env: {
        ...process.env,
        FORCE_COLOR: '0',
        // nur für den E2E-Schritt: die Umgebungsvariable hat bei Playwright Vorrang vor der Konfiguration
        ...(args.includes('e2e/playwright.config.ts') ? { PLAYWRIGHT_JSON_OUTPUT_FILE: E2E_JSON } : {}),
        FULL_UI_JSON: UI_JSON,
        FULL_UI_OUTPUT: join(TEMP, 'user'),
      },
    });
    const collect = (chunk: Buffer) => {
      output += chunk.toString();
      process.stdout.write(chunk);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('close', (code) => resolve({ ok: code === 0, output }));
  });
}

/** Optional: Lauf in Dev Log ablegen (Ansicht „Testläufe“), Schritt für Schritt, damit er live erscheint. */
class Recorder {
  private constructor(
    private readonly pool: Pool,
    private readonly runId: string,
  ) {}

  static async open(slug: string): Promise<Recorder> {
    const environment = { ...process.env, DEV_LOG_DATABASE_URL: process.env.DEV_LOG_DATABASE_URL ?? LOCAL_DATABASE };
    const pool = await createDatabasePool(readDatabaseConfig(environment));
    const exists = await pool.query('SELECT 1 FROM projects WHERE slug = $1', [slug]);
    if (!exists.rowCount) {
      await pool.end();
      throw new Error(`Projekt „${slug}“ gibt es in Dev Log nicht – zuerst in der Oberfläche anlegen.`);
    }
    const git = async (args: string[]) =>
      (await promisify(execFile)('git', args, { cwd: ROOT }).catch(() => ({ stdout: '' }))).stdout.trim() || null;
    const runId = await createTestRun(pool, {
      projectSlug: slug,
      trigger: 'full',
      branch: await git(['rev-parse', '--abbrev-ref', 'HEAD']),
      commitSha: await git(['rev-parse', 'HEAD']),
    });
    return new Recorder(pool, runId);
  }

  async start(position: number, step: Step): Promise<void> {
    await createTestRunStep(this.pool, {
      runId: this.runId,
      position,
      command: [step.command, ...step.args].join(' '),
      output: '',
      category: step.category,
    });
  }

  async finish(position: number, result: StepResult): Promise<number> {
    await finishTestRunStep(this.pool, {
      runId: this.runId,
      position,
      exitCode: result.ok ? 0 : 1,
      durationMs: result.seconds * 1000,
      output: redactOutput(`${result.summary}\n\n${result.tail}`, process.env),
    });
    return saveTestCases(this.pool, this.runId, result.cases);
  }

  get id(): string {
    return this.runId;
  }

  async close(passed: boolean, report: string): Promise<string> {
    await saveTestReport(this.pool, this.runId, report);
    await finishTestRun(this.pool, this.runId, passed);
    await this.pool.end();
    return this.runId;
  }
}

async function runStep(position: number, step: Step, recorder: Recorder | null): Promise<StepResult> {
  console.log(`\n━━ ${step.name} ━━`);
  await recorder?.start(position, step);
  const begin = Date.now();
  const { ok, output } = await run(step.command, step.args);
  const clean = output.replace(ANSI, '');
  const result: StepResult = {
    name: step.name,
    ok,
    seconds: Math.round((Date.now() - begin) / 1000),
    summary: step.summary(clean),
    tail: clean.trim().split('\n').slice(-25).join('\n'),
    cases: (await step.cases?.(clean)) ?? [],
  };
  const media = await recorder?.finish(position, result);
  if (media) console.log(`→ ${result.cases.length} Einzeltests und ${media} Screenshots/Videos in Dev Log abgelegt`);
  return result;
}

let mediaCount = 0;
async function keep(path: string, label: string): Promise<string | null> {
  if (!existsSync(path)) return null;
  mediaCount += 1;
  const safe = label
    .replace(/[^a-z0-9äöü]+/gi, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
  const target = join(MEDIA, `${String(mediaCount).padStart(3, '0')}-${safe}${extname(path)}`);
  await copyFile(path, target);
  return relative(OUT, target).split('\\').join('/');
}

const icon = (ok: boolean) => (ok ? '✅' : '❌');
const STATUS_ICON: Record<TestCaseResult['status'], string> = {
  passed: '✅',
  failed: '❌',
  skipped: '⏭️',
  flaky: '⚠️',
};

/**
 * Bericht für die Dokumentation in Dev Log (Gruppe „Testberichte“): Übersicht je Kategorie und alle Befunde.
 * Screenshots und Videos zeigt die Ansicht „Testläufe“, auf die der Bericht verlinkt.
 */
function documentReport(results: StepResult[], allOk: boolean, runId: string): string {
  const cases = results.flatMap((result) => result.cases);
  const count = (category: string, status: string) =>
    cases.filter((testCase) => testCase.category === category && testCase.status === status).length;
  const categories = (['unit', 'e2e', 'user'] as const)
    .map((category) => ({
      label: { unit: 'Unit', e2e: 'E2E', user: 'User' }[category],
      passed: count(category, 'passed'),
      failed: count(category, 'failed') + count(category, 'flaky'),
      skipped: count(category, 'skipped'),
    }))
    .filter((category) => category.passed + category.failed + category.skipped);
  const failed = cases.filter((testCase) => testCase.status === 'failed' || testCase.status === 'flaky');
  const row = (text: string) => text.replace(/\|/g, '/').replace(/\s+/g, ' ');
  return [
    `# Testbericht ${started.toLocaleString('de-CH', { dateStyle: 'medium', timeStyle: 'short' })}`,
    '',
    `Gesamtergebnis: ${icon(allOk)} ${allOk ? 'alles grün' : 'mit Befunden'} · erstellt mit \`npm run test:full\``,
    '',
    `[Screenshots, Videos und alle Einzeltests in den Testläufen ansehen](#runs/${runId})`,
    '',
    '## Prüfungen',
    '',
    '| Prüfung | Ergebnis | Dauer | Zusammenfassung |',
    '|---|---|---|---|',
    ...results.map(
      (result) => `| ${result.name} | ${icon(result.ok)} | ${result.seconds} s | ${row(result.summary || '–')} |`,
    ),
    '',
    '## Einzeltests je Kategorie',
    '',
    '| Kategorie | Bestanden | Fehlgeschlagen | Übersprungen |',
    '|---|---|---|---|',
    ...categories.map(
      (category) => `| ${category.label} | ${category.passed} | ${category.failed} | ${category.skipped} |`,
    ),
    '',
    '## Befunde',
    '',
    ...(failed.length
      ? failed.flatMap((testCase) => [
          `### ${STATUS_ICON[testCase.status]} ${testCase.title}`,
          '',
          `${{ unit: 'Unit', e2e: 'E2E', user: 'User' }[testCase.category]}${testCase.device ? ` · ${testCase.device}` : ''}${testCase.file ? ` · \`${testCase.file}\`` : ''}`,
          '',
          ...(testCase.errors.length ? testCase.errors.map((error) => `- ${row(error)}`) : ['- ohne Meldung']),
          '',
        ])
      : ['Keine Befunde.']),
    ...results
      .filter((result) => !result.ok && !result.cases.length)
      .flatMap((result) => [`### ❌ ${result.name}`, '', `- ${row(result.summary || 'fehlgeschlagen')}`, '']),
  ].join('\n');
}

async function main(): Promise<void> {
  await mkdir(TEMP, { recursive: true });
  const recorder = project ? await Recorder.open(project) : null;
  const steps = onlyUi ? [USER_STEP] : [...STEPS, USER_STEP];
  const results: StepResult[] = [];
  for (const [position, step] of steps.entries()) results.push(await runStep(position, step, recorder));

  // Bericht: Befunde und Medien des Oberflächentests
  await mkdir(MEDIA, { recursive: true });
  const userCases = results.at(-1)?.cases ?? [];
  const findings: string[] = [];
  const sections: string[] = [];
  for (const testCase of userCases) {
    const label = `${testCase.title} · ${testCase.device}`;
    testCase.errors.forEach((error) =>
      findings.push(`| ${testCase.device} | ${testCase.title} | ${error.replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`),
    );
    const lines = [
      `### ${STATUS_ICON[testCase.status]} ${label}`,
      '',
      `Status: ${testCase.status} · Dauer ${((testCase.durationMs ?? 0) / 1000).toFixed(1)} s`,
    ];
    if (testCase.errors.length) lines.push('', '**Befunde:**', '', ...testCase.errors.map((error) => `- ${error}`));
    for (const file of testCase.media) {
      const saved = await keep(
        file.path,
        `${testCase.device}-${file.mime.startsWith('video') ? testCase.title : file.name}`,
      );
      if (!saved) continue;
      lines.push(
        '',
        file.mime.startsWith('video')
          ? `🎬 [Video ansehen](${saved})`
          : `**${file.name}**\n\n![${file.name}](${saved})`,
      );
    }
    sections.push(lines.join('\n'));
  }

  const allOk = results.every((result) => result.ok);
  const runId = recorder?.id;
  const markdown = [
    `# Testbericht ${started.toLocaleString('de-CH')}`,
    '',
    `Erstellt mit \`npm run test:full\`. Gesamtergebnis: ${icon(allOk)} ${allOk ? 'alles grün' : 'mit Befunden'}.`,
    'Der Oberflächentest läuft auf einer eigenen Testdatenbank (dev_log_full) ohne Worker: Agents, Chat-Antworten und der Projekt-Assistent starten dort nicht.',
    runId ? `In Dev Log abgelegt: Projekt \`${project}\`, Testlauf \`${runId}\`.` : '',
    '',
    '## Übersicht',
    '',
    '| Prüfung | Ergebnis | Dauer | Zusammenfassung |',
    '|---|---|---|---|',
    ...results.map(
      (result) => `| ${result.name} | ${icon(result.ok)} | ${result.seconds} s | ${result.summary || '–'} |`,
    ),
    '',
    '## Befunde des Oberflächentests',
    '',
    findings.length ? '| Gerät | Test | Befund |\n|---|---|---|\n' + findings.join('\n') : 'Keine Befunde.',
    '',
    '## Oberflächentest im Detail',
    '',
    sections.join('\n\n') || 'Kein Ergebnis (Oberflächentest lief nicht).',
    '',
    '## Ausgabe fehlgeschlagener Prüfungen',
    '',
    ...results
      .filter((result) => !result.ok)
      .map(
        (result) => `<details><summary>${result.name}</summary>\n\n\`\`\`text\n${result.tail}\n\`\`\`\n\n</details>\n`,
      ),
    '',
  ].join('\n');
  await writeFile(join(OUT, 'bericht.md'), markdown);
  if (recorder) await recorder.close(allOk, documentReport(results, allOk, recorder.id));
  await rm(TEMP, { recursive: true, force: true });
  console.log(
    `\nBericht: ${relative(ROOT, join(OUT, 'bericht.md'))} (${mediaCount} Screenshots/Videos in ${basename(MEDIA)}/)`,
  );
  if (runId) console.log(`Dev Log: Projekt „${project}“ → Testläufe`);
  process.exitCode = allOk ? 0 : 1;
}

await main();
