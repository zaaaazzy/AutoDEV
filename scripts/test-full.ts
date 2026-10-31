/**
 * Kompletter Testlauf mit Bericht: Lint, Formatierung, Typen, Unit-Tests, E2E-Tests und der Oberflächentest
 * (e2e/full-ui.check.ts, mit Video und Screenshots). Schreibt den Bericht nach docs/tests/<Datum_Uhrzeit>/ und,
 * mit --projekt, den Lauf samt Einzeltests, Screenshots und Videos in die Ansicht „Testläufe“ dieses Projekts.
 *
 *   npm run test:full                          alles
 *   npm run test:full -- --projekt devlog      zusätzlich in AIdeation unter Testläufe ablegen
 *   npm run test:full -- --nur-oberflaeche     nur der Oberflächentest (UI muss gebaut sein: npm run build:ui)
 *   npm run test:full -- --projekt devlog --bugs   Befunde zusätzlich als Bugs anlegen (Quelle „Testlauf“)
 *
 * Datenbank für --projekt: DEV_LOG_DATABASE_URL, sonst die lokale aus docker-compose (127.0.0.1:5433) mit dem
 * Zugang aus der .env (DEV_LOG_DB_USER, DEV_LOG_DB_PASSWORD).
 */
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
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
import { caseBugs, fileBugs, stepBug } from '../src/core/test-bugs.js';
import { waitForBugCategories } from '../src/agent/bug-classifier.js';
import { adminDatabaseUrl, localDatabaseUrl, readEnvValues } from '../src/core/local-database.js';
import { connectExistingDatabase, readDatabaseConfig } from '../src/db/database.js';
import {
  createTestRun,
  createTestRunStep,
  finishTestRun,
  finishTestRunStep,
  saveTestCases,
  saveTestReport,
  updateTestRunStepProgress,
} from '../src/db/test-runs.js';
import { stepProgress } from '../src/core/test-progress.js';

const ROOT = join(import.meta.dirname, '..');
const argument = (name: string) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const onlyUi = process.argv.includes('--nur-oberflaeche');
const project = argument('--projekt') ?? process.env.DEV_LOG_TEST_PROJECT;
/** Testanforderung aus AIdeation (Dashboard, Testläufe): der Lauf wird ihr zugeordnet. */
const requestId = argument('--anfrage');
/** Befunde als Bugs anlegen (je fehlgeschlagenem Test einer, ohne Dubletten zu offenen Bugs). */
const fileFindings = process.argv.includes('--bugs');
const started = new Date();
const two = (value: number) => String(value).padStart(2, '0');
const stamp = `${started.getFullYear()}-${two(started.getMonth() + 1)}-${two(started.getDate())}_${two(started.getHours())}-${two(started.getMinutes())}`;
// Rohdaten je Lauf getrennt, damit parallele Läufe sich nicht gegenseitig löschen
const TEMP = join(tmpdir(), `dev-log-test-full-${stamp}`);
const OUT = join(ROOT, 'docs', 'tests', stamp);
const MEDIA = join(OUT, 'media');
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
// Zugang aus der .env (DEV_LOG_DB_USER/DEV_LOG_DB_PASSWORD); fehlt das Passwort, bricht der Lauf mit Hinweis ab.
// Erst bei Bedarf gelesen: Ist die Adresse vorgegeben, braucht es die .env nicht.
const localDatabase = (): string => localDatabaseUrl(readEnvValues(ROOT));
const E2E_ADMIN = process.env.E2E_ADMIN_DATABASE_URL ?? adminDatabaseUrl(localDatabase());

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
const UI_BUILD_STEP: Step = {
  name: 'UI-Build',
  command: 'npm',
  args: ['run', 'build:ui'],
  category: 'quality',
  summary: (out) => (/bundle generation complete/i.test(out) ? 'Oberfläche gebaut' : 'Build fehlgeschlagen'),
};
const USER_STEP: Step = {
  name: 'Oberflächentest',
  command: 'npx',
  args: ['playwright', 'test', '-c', 'e2e/full.config.ts'],
  category: 'user',
  summary: (out) => counted(out, ['passed', 'failed', 'skipped']),
  cases: () => playwrightCases(UI_JSON, 'user'),
};

/** Führt einen Befehl aus, zeigt die Ausgabe live und gibt sie gesammelt zurück. */
function run(
  command: string,
  args: string[],
  quiet = false,
  onOutput?: (output: string) => void,
): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    let output = '';
    // Die Schritte brauchen die AIdeation-Datenbank nicht (nur der Recorder), wohl aber das Admin-Ziel für E2E.
    const environment = { ...process.env };
    delete environment.DEV_LOG_DATABASE_URL;
    const child = spawn(command, args, {
      cwd: ROOT,
      shell: process.platform === 'win32',
      env: {
        ...environment,
        E2E_ADMIN_DATABASE_URL: E2E_ADMIN,
        FORCE_COLOR: '0',
        // nur für den E2E-Schritt: die Umgebungsvariable hat bei Playwright Vorrang vor der Konfiguration
        ...(args.includes('e2e/playwright.config.ts') ? { PLAYWRIGHT_JSON_OUTPUT_FILE: E2E_JSON } : {}),
        FULL_UI_JSON: UI_JSON,
        FULL_UI_OUTPUT: join(TEMP, 'user'),
      },
    });
    const collect = (chunk: Buffer) => {
      output += chunk.toString();
      // Parallel laufende Schritte nicht ineinander verschränkt ausgeben; ihr Ergebnis folgt am Ende gesammelt.
      if (!quiet) process.stdout.write(chunk);
      onOutput?.(output);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('close', (code) => resolve({ ok: code === 0, output }));
  });
}

/** Optional: Lauf in AIdeation ablegen (Ansicht „Testläufe“), Schritt für Schritt, damit er live erscheint. */
class Recorder {
  private constructor(
    private readonly pool: Pool,
    private readonly runId: string,
  ) {}

  static async open(slug: string): Promise<Recorder> {
    const environment = { ...process.env, DEV_LOG_DATABASE_URL: process.env.DEV_LOG_DATABASE_URL ?? localDatabase() };
    // Nur mitschreiben: Der getestete Stand ist noch nicht freigegeben und darf das Schema nicht migrieren.
    const pool = connectExistingDatabase(readDatabaseConfig(environment));
    const exists = await pool.query('SELECT 1 FROM projects WHERE slug = $1', [slug]);
    if (!exists.rowCount) {
      await pool.end();
      throw new Error(`Projekt „${slug}“ gibt es in AIdeation nicht – zuerst in der Oberfläche anlegen.`);
    }
    const git = async (args: string[]) =>
      (await promisify(execFile)('git', args, { cwd: ROOT }).catch(() => ({ stdout: '' }))).stdout.trim() || null;
    const runId = await createTestRun(pool, {
      projectSlug: slug,
      trigger: 'full',
      branch: await git(['rev-parse', '--abbrev-ref', 'HEAD']),
      commitSha: await git(['rev-parse', 'HEAD']),
    });
    if (requestId) await pool.query('UPDATE test_requests SET run_id = $2 WHERE id = $1', [requestId, runId]);
    return new Recorder(pool, runId);
  }

  /** Bugs aus allen Befunden dieses Laufs; mit Anfrage wird die Zahl dort vermerkt. */
  async fileBugs(results: StepResult[], project: string): Promise<number> {
    const drafts = results.flatMap((result) =>
      result.cases.length
        ? caseBugs(result.cases, this.runId)
        : result.ok
          ? []
          : [stepBug(result.name, result.tail, this.runId)],
    );
    const created = await fileBugs(this.pool, project, drafts);
    if (requestId) await this.pool.query('UPDATE test_requests SET bug_count = $2 WHERE id = $1', [requestId, created]);
    return created;
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

  /** Zwischenstand für die Live-Anzeige unter „Testläufe“; Fehler hier dürfen den Lauf nicht stören. */
  async progress(position: number, output: string): Promise<void> {
    await updateTestRunStepProgress(this.pool, {
      runId: this.runId,
      position,
      progress: stepProgress(output).text,
      output: redactOutput(output.replace(ANSI, '').slice(-4_000), process.env),
    }).catch(() => undefined);
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
    // Kategorien neuer Bugs (lokales Modell im Hintergrund) kurz abwarten; was dann noch fehlt, bleibt leer.
    await waitForBugCategories(60_000);
    await this.pool.end();
    return this.runId;
  }
}

async function runStep(position: number, step: Step, recorder: Recorder | null, quiet = false): Promise<StepResult> {
  console.log(`\n━━ ${step.name}${quiet ? ' (läuft parallel, Ausgabe folgt am Ende)' : ''} ━━`);
  await recorder?.start(position, step);
  const begin = Date.now();
  // Live-Fortschritt höchstens alle 2 s schreiben (Ansicht „Testläufe“ lädt im selben Takt nach).
  let latest = '';
  let written = '';
  const live = recorder
    ? setInterval(() => {
        if (latest === written) return;
        written = latest;
        void recorder.progress(position, latest);
      }, 2_000)
    : undefined;
  const { ok, output } = await run(step.command, step.args, quiet, (current) => (latest = current)).finally(() =>
    clearInterval(live),
  );
  if (quiet) {
    const lines = output.replace(ANSI, '').trim().split('\n');
    console.log(`\n━━ ${step.name}: ${ok ? 'grün' : 'rot'} ━━\n${lines.slice(ok ? -8 : -80).join('\n')}`);
  }
  const clean = output.replace(ANSI, '');
  const result: StepResult = {
    name: step.name,
    ok,
    seconds: Math.round((Date.now() - begin) / 1000),
    summary: step.summary(clean),
    tail: clean.trim().slice(-60_000),
    cases: (await step.cases?.(clean)) ?? [],
  };
  const media = await recorder?.finish(position, result);
  if (media) console.log(`→ ${result.cases.length} Einzeltests und ${media} Screenshots/Videos in AIdeation abgelegt`);
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
 * Bericht für die Dokumentation in AIdeation (Gruppe „Testberichte“): Übersicht je Kategorie und alle Befunde.
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
  // Nur Oberfläche: vorher die App bauen, sonst prüft der Test einen veralteten Stand (z. B. im Agenten-Worktree).
  const steps = onlyUi ? [UI_BUILD_STEP, USER_STEP] : [...STEPS, USER_STEP];
  const results: StepResult[] = [];
  // E2E- und Oberflächentest gleichzeitig: Sie haben eigene Ports und eigene Testdatenbanken (dev_log_e2e, dev_log_full)
  // und brauchen beide nur die gebaute Oberfläche aus dem Schritt davor.
  const PARALLEL = new Set(['E2E-Tests', 'Oberflächentest']);
  for (let position = 0; position < steps.length; position++) {
    const step = steps[position]!;
    const next = steps[position + 1];
    if (next && PARALLEL.has(step.name) && PARALLEL.has(next.name)) {
      results.push(
        ...(await Promise.all([runStep(position, step, recorder, true), runStep(position + 1, next, recorder, true)])),
      );
      position += 1;
      continue;
    }
    results.push(await runStep(position, step, recorder));
  }

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
    runId ? `In AIdeation abgelegt: Projekt \`${project}\`, Testlauf \`${runId}\`.` : '',
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
        (result) =>
          `<details><summary>${result.name}</summary>\n\n\`\`\`text\n${result.tail.split('\n').slice(-40).join('\n')}\n\`\`\`\n\n</details>\n`,
      ),
    '',
  ].join('\n');
  await writeFile(join(OUT, 'bericht.md'), markdown);
  if (recorder && fileFindings && project) {
    const bugs = await recorder.fileBugs(results, project);
    console.log(`→ ${bugs} neue Bugs aus den Befunden angelegt`);
  }
  if (recorder) await recorder.close(allOk, documentReport(results, allOk, recorder.id));
  await rm(TEMP, { recursive: true, force: true });
  console.log(
    `\nBericht: ${relative(ROOT, join(OUT, 'bericht.md'))} (${mediaCount} Screenshots/Videos in ${basename(MEDIA)}/)`,
  );
  if (runId) console.log(`AIdeation: Projekt „${project}“ → Testläufe`);
  process.exitCode = allOk ? 0 : 1;
}

/**
 * Nur ein Komplettlauf zugleich auf dieser Maschine: E2E- und Oberflächentest nutzen feste Testdatenbanken
 * (dev_log_e2e, dev_log_full) und Ports. Zwei Läufe nebeneinander (Worker-Gate und Handlauf, oder zwei Projekte)
 * löschten sich gegenseitig die Datenbank unter dem Server weg (ECONNREFUSED, „deadlock detected“). Die Sperre ist
 * ein Ordner im Temp-Verzeichnis; ein liegen gebliebener (Absturz) gilt nach 45 Minuten als verwaist.
 */
const LOCK = join(tmpdir(), 'dev-log-test-full.lock');
const LOCK_STALE_MS = 45 * 60_000;
const LOCK_WAIT_MS = 10_000;
async function withSingleRun<T>(task: () => Promise<T>): Promise<T> {
  const started = Date.now();
  for (;;) {
    try {
      await mkdir(LOCK);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const age =
        Date.now() -
        (await stat(LOCK)
          .then((info) => info.mtimeMs)
          .catch(() => Date.now()));
      if (age > LOCK_STALE_MS) {
        console.log('Verwaiste Sperre eines früheren Komplettlaufs entfernt.');
        await rm(LOCK, { recursive: true, force: true });
        continue;
      }
      if (Date.now() - started > LOCK_STALE_MS)
        throw new Error('Ein anderer Komplettlauf blockiert seit über 45 Minuten.', { cause: error });
      if (Date.now() - started < LOCK_WAIT_MS)
        console.log('Ein anderer Komplettlauf läuft gerade – warte, bis er fertig ist …');
      await new Promise((resolve) => setTimeout(resolve, LOCK_WAIT_MS));
    }
  }
  try {
    await writeFile(join(LOCK, 'pid'), String(process.pid));
    return await task();
  } finally {
    await rm(LOCK, { recursive: true, force: true });
  }
}

await withSingleRun(main);
