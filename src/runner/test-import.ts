import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import type { Pool } from 'pg';
import { redactOutput } from '../core/command.js';
import { documentReport, type FullTestResult, type FullTestStep } from '../core/full-test-result.js';
import { caseBugs, fileBugs, stepBug } from '../core/test-bugs.js';
import { TEST_CATEGORIES, type TestCaseMedia, type TestCaseResult } from '../core/test-results.js';
import {
  createTestRun,
  createTestRunStep,
  finishTestRun,
  finishTestRunStep,
  saveTestCases,
  saveTestReport,
} from '../db/test-runs.js';

const CASE_CATEGORIES = new Set(['unit', 'e2e', 'user']);
const CASE_STATUS = new Set(['passed', 'failed', 'skipped', 'flaky']);
const MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'video/webm']);

/**
 * Echter Pfad innerhalb des Projektordners, sonst null. Die Datei kommt aus der Sandbox: Ein Symlink oder „../“
 * darf den Worker nicht dazu bringen, Dateien des Hosts (z. B. die .env eines anderen Ordners) in die Datenbank zu laden.
 */
async function insideProject(root: string, path: string): Promise<string | null> {
  const real = await realpath(resolve(root, path)).catch(() => null);
  if (!real) return null;
  const rest = relative(root, real);
  return rest && !rest.startsWith('..') && !isAbsolute(rest) ? real : null;
}

const text = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback);

async function cleanCase(root: string, raw: TestCaseResult): Promise<TestCaseResult | null> {
  if (!CASE_CATEGORIES.has(raw?.category) || !CASE_STATUS.has(raw?.status)) return null;
  const media: TestCaseMedia[] = [];
  for (const file of Array.isArray(raw.media) ? raw.media : []) {
    if (!MEDIA_TYPES.has(file?.mime) || typeof file.path !== 'string') continue;
    const path = await insideProject(root, file.path);
    if (path) media.push({ name: text(file.name, 'Anhang'), mime: file.mime, path });
  }
  return {
    category: raw.category,
    title: text(raw.title, 'ohne Titel'),
    file: typeof raw.file === 'string' ? raw.file : null,
    device: typeof raw.device === 'string' ? raw.device : null,
    status: raw.status,
    durationMs: typeof raw.durationMs === 'number' ? raw.durationMs : null,
    errors: Array.isArray(raw.errors) ? raw.errors.filter((error) => typeof error === 'string') : [],
    media,
  };
}

async function cleanStep(root: string, raw: FullTestStep): Promise<FullTestStep> {
  const cases = await Promise.all((Array.isArray(raw.cases) ? raw.cases : []).map((item) => cleanCase(root, item)));
  return {
    name: text(raw.name, 'Schritt'),
    command: text(raw.command, text(raw.name, 'Schritt')),
    category: (TEST_CATEGORIES as readonly string[]).includes(raw.category) ? raw.category : 'quality',
    ok: raw.ok === true,
    seconds: typeof raw.seconds === 'number' ? raw.seconds : 0,
    summary: text(raw.summary),
    tail: text(raw.tail),
    cases: cases.filter((item): item is TestCaseResult => item !== null),
  };
}

/**
 * Legt den Komplettlauf aus der Ergebnisdatei als Testlauf an (Schritte, Einzeltests, Screenshots/Videos, Bericht),
 * verknüpft ihn mit der Testanforderung und legt mit `bugs` die Befunde als Bugs an. Liefert die Lauf-ID, oder null,
 * wenn es keine (gültige) Ergebnisdatei gibt.
 */
export async function importFullTestResult(
  pool: Pool,
  options: {
    project: string;
    cwd: string;
    file: string;
    requestId: string;
    branch: string | null;
    commitSha: string | null;
    bugs: boolean;
  },
): Promise<string | null> {
  const root = await realpath(options.cwd);
  const file = await insideProject(root, options.file);
  if (!file) return null;
  let parsed: FullTestResult;
  try {
    parsed = JSON.parse(await readFile(file, 'utf8')) as FullTestResult;
  } catch {
    return null;
  }
  if (parsed?.version !== 1 || !Array.isArray(parsed.steps)) return null;
  const steps = await Promise.all(parsed.steps.map((step) => cleanStep(root, step)));
  const passed = steps.every((step) => step.ok);
  const runId = await createTestRun(pool, {
    projectSlug: options.project,
    trigger: 'full',
    branch: options.branch,
    commitSha: options.commitSha,
    platform: text(parsed.platform).slice(0, 40) || undefined,
  });
  await pool.query('UPDATE test_requests SET run_id = $2 WHERE id = $1', [options.requestId, runId]);
  for (const [position, step] of steps.entries()) {
    await createTestRunStep(pool, { runId, position, command: step.command, output: '', category: step.category });
    await finishTestRunStep(pool, {
      runId,
      position,
      exitCode: step.ok ? 0 : 1,
      durationMs: step.seconds * 1000,
      output: redactOutput(`${step.summary}\n\n${step.tail}`, process.env),
    });
    await saveTestCases(pool, runId, step.cases);
  }
  if (options.bugs) {
    const drafts = steps.flatMap((step) =>
      step.cases.length ? caseBugs(step.cases, runId) : step.ok ? [] : [stepBug(step.name, step.tail, runId)],
    );
    const created = await fileBugs(pool, options.project, drafts);
    await pool.query('UPDATE test_requests SET bug_count = $2 WHERE id = $1', [options.requestId, created]);
  }
  const started = new Date(text(parsed.startedAt));
  await saveTestReport(
    pool,
    runId,
    documentReport(steps, passed, runId, Number.isNaN(started.getTime()) ? new Date() : started),
  );
  await finishTestRun(pool, runId, passed);
  return runId;
}
