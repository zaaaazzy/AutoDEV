import { defined } from './defined.js';

/** Testkategorien und Einzelergebnisse für die Ansicht „Testläufe“. */
export const TEST_CATEGORIES = ['quality', 'unit', 'e2e', 'user'] as const;
export type TestCategory = (typeof TEST_CATEGORIES)[number];
export type CaseCategory = Exclude<TestCategory, 'quality'>;
export type CaseStatus = 'passed' | 'failed' | 'skipped' | 'flaky';

export interface TestCaseMedia {
  name: string;
  mime: 'image/png' | 'image/jpeg' | 'video/webm';
  path: string;
}

export interface TestCaseResult {
  category: CaseCategory;
  title: string;
  file: string | null;
  device: string | null;
  status: CaseStatus;
  durationMs: number | null;
  errors: string[];
  media: TestCaseMedia[];
}

/** Kategorie eines Testbefehls, wenn sie nicht ausdrücklich angegeben ist. */
export function categoryOfCommand(command: string): TestCategory {
  if (/full\.config|full-ui|user/i.test(command)) return 'user';
  if (/playwright|cypress|e2e/i.test(command)) return 'e2e';
  if (/\b(lint|eslint|prettier|format|typecheck|tsc|build)\b/i.test(command)) return 'quality';
  return 'unit';
}

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const MAX_ERRORS = 20;
const MAX_ERROR_LENGTH = 600;

function cleanError(message: string): string {
  return message.replace(ANSI, '').trim().slice(0, MAX_ERROR_LENGTH);
}

/** Testdatei aus `location` (TAP, Node ≥ 20): ohne `file://`, Zeile und Spalte; relativ zum Arbeitsordner. */
function tapLocation(value: string, root: string): string | null {
  const path = value
    .trim()
    .replace(/^['"]|['"]$/g, '')
    .replace(/^file:\/\//, '')
    .replace(/(?::\d+)+$/, '')
    .replace(/\\/g, '/');
  if (!path) return null;
  const base = `${root.replace(/\\/g, '/').replace(/\/$/, '')}/`;
  return path.startsWith(base) ? path.slice(base.length) : path;
}

/**
 * Einzeltests aus TAP (node --test, tsx --test): nur Tests der obersten Ebene, mit Dauer und Fehlermeldung
 * aus dem YAML-Block. Unterschiedlich eingerückte Untertests werden ihrem Elterntest zugerechnet.
 */
export function parseTapCases(output: string, root = process.cwd()): TestCaseResult[] {
  const lines = output.replace(ANSI, '').split('\n');
  const cases: TestCaseResult[] = [];
  for (let index = 0; index < lines.length; index++) {
    const match = /^(not ok|ok) \d+ - (.+?)(?:\s+#\s*(SKIP|TODO)\b.*)?$/.exec(defined(lines[index]));
    if (!match) continue;
    let durationMs: number | null = null;
    let file: string | null = null;
    const errors: string[] = [];
    if (lines[index + 1]?.trim() === '---') {
      for (let inner = index + 2; inner < lines.length && defined(lines[inner]).trim() !== '...'; inner++) {
        const line = defined(lines[inner]);
        const duration = /^\s+duration_ms:\s*([\d.]+)/.exec(line);
        if (duration) durationMs = Math.round(Number(duration[1]));
        // Nur die eigene Ebene (zwei Leerzeichen); Untertests stehen tiefer eingerückt.
        const location = /^ {2}location:\s*(.+)$/.exec(line);
        if (location && !file) file = tapLocation(defined(location[1]), root);
        const error = /^\s+error:\s*(.*)$/.exec(line);
        if (error) {
          const quoted = defined(error[1])
            .replace(/^['"|>-]+\s*/, '')
            .replace(/['"]$/, '');
          const next = quoted || lines[inner + 1]?.trim() || '';
          if (next && errors.length < MAX_ERRORS) errors.push(cleanError(next));
        }
      }
    }
    const skipped = Boolean(match[3]);
    cases.push({
      category: 'unit',
      title: defined(match[2]).trim(),
      file,
      device: null,
      status: skipped ? 'skipped' : match[1] === 'ok' ? 'passed' : 'failed',
      durationMs,
      errors,
      media: [],
    });
  }
  return cases;
}

interface PlaywrightAttachment {
  name: string;
  contentType: string;
  path?: string;
}
interface PlaywrightResult {
  duration: number;
  errors?: { message?: string }[];
  attachments?: PlaywrightAttachment[];
}
interface PlaywrightTest {
  projectName: string;
  status: 'expected' | 'unexpected' | 'skipped' | 'flaky';
  results: PlaywrightResult[];
}
interface PlaywrightSpec {
  title: string;
  file: string;
  tests: PlaywrightTest[];
}
interface PlaywrightSuite {
  specs?: PlaywrightSpec[];
  suites?: PlaywrightSuite[];
}
export interface PlaywrightReport {
  suites: PlaywrightSuite[];
}

const PLAYWRIGHT_STATUS: Record<PlaywrightTest['status'], CaseStatus> = {
  expected: 'passed',
  unexpected: 'failed',
  skipped: 'skipped',
  flaky: 'flaky',
};

/** Kurzfassung einer Playwright-Meldung: eigene Meldung bzw. erste Zeile, bei allgemeinen Meldungen mit Locator. */
export function playwrightHeadline(message = ''): string {
  const lines = message
    .replace(ANSI, '')
    .split('\n')
    .map((line) => line.trim());
  const first = (lines[0] ?? '').replace(/^Error: /, '');
  const locator = lines.find((line) => line.startsWith('Locator:'));
  const waiting = lines.filter((line) => line.startsWith('- waiting for')).at(-1);
  const generic = /failed$|exceeded\.?$/.test(first);
  return [first, generic ? (locator ?? waiting?.slice(2)) : undefined]
    .filter(Boolean)
    .join(' – ')
    .slice(0, MAX_ERROR_LENGTH);
}

function mediaOf(attachments: PlaywrightAttachment[] = []): TestCaseMedia[] {
  return attachments.flatMap((attachment) => {
    if (!attachment.path) return [];
    const mime =
      attachment.contentType === 'image/png' || attachment.contentType === 'image/jpeg'
        ? attachment.contentType
        : attachment.contentType.startsWith('video/')
          ? 'video/webm'
          : null;
    if (!mime) return [];
    const name =
      attachment.name === 'screenshot' ? 'Bildschirm am Ende' : attachment.name === 'video' ? 'Video' : attachment.name;
    return [{ name, mime, path: attachment.path }];
  });
}

/** Einzeltests aus dem JSON-Reporter von Playwright, je Gerät (Projekt) ein Eintrag samt Screenshots und Video. */
export function parsePlaywrightCases(report: PlaywrightReport, category: CaseCategory): TestCaseResult[] {
  const specs = (suite: PlaywrightSuite): PlaywrightSpec[] => [
    ...(suite.specs ?? []),
    ...(suite.suites ?? []).flatMap(specs),
  ];
  return report.suites.flatMap(specs).flatMap((spec) =>
    spec.tests.map((test) => {
      const result = test.results.at(-1);
      return {
        category,
        title: spec.title,
        file: spec.file,
        device: test.projectName || null,
        status: PLAYWRIGHT_STATUS[test.status] ?? 'failed',
        durationMs: result ? Math.round(result.duration) : null,
        errors: (result?.errors ?? [])
          .map((error) => playwrightHeadline(error.message))
          .filter(Boolean)
          .slice(0, MAX_ERRORS),
        media: mediaOf(result?.attachments),
      };
    }),
  );
}

const ERROR_LINE = /^(?:\w*Error\b|Error:|AssertionError|TypeError|ReferenceError|SyntaxError|Expected|Received)/;

/** Stelle im Projekt aus einem Stacktrace (ohne node_modules und Node-Interna), z. B. „e2e/app.spec.ts:48“. */
function projectLocation(lines: string[]): string | null {
  for (const line of lines) {
    const match = /\(?((?:\/|[A-Za-z]:\\)[^():]+):(\d+)(?::\d+)?\)?\s*$/.exec(line);
    if (!match || defined(match[1]).includes('node_modules') || defined(match[1]).startsWith('node:')) continue;
    const parts = defined(match[1]).split(/[\\/]/);
    const anchor = parts.findIndex((part) =>
      ['src', 'e2e', 'frontend', 'tests', 'test', 'backend', 'scripts'].includes(part),
    );
    return `${(anchor >= 0 ? parts.slice(anchor) : parts.slice(-2)).join('/')}:${match[2]}`;
  }
  return null;
}

/** Bekannte Ursachen mit einem Satz, was zu tun ist. */
const FAILURE_HINTS: [RegExp, string][] = [
  [
    /Playwright Test did not expect test\.\w+\(\) to be called here/,
    'Eine Playwright-Datei wurde mit dem Node-Testrunner (tsx/node --test) gestartet. Playwright-Tests mit `npx playwright test -c <konfiguration>` ausführen.',
  ],
  [
    /Cannot find module|ERR_MODULE_NOT_FOUND/,
    'Ein Modul fehlt: Pfad prüfen oder Abhängigkeiten installieren (`npm ci`).',
  ],
];

/**
 * Lesbare Zusammenfassung einer Node-Testausgabe (TAP) für Fehlermeldungen in der Oberfläche: Zahlen, die
 * fehlgeschlagenen Tests mit erster Fehlerzeile und Stelle, bekannte Ursachen mit Hinweis. Ohne TAP: null.
 */
export function summarizeTestFailure(output: string): string | null {
  const clean = output.replace(ANSI, '');
  const cases = parseTapCases(clean);
  if (!cases.length) return null;
  const lines = clean.split('\n');
  const failed: string[] = [];
  let block: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = defined(lines[index]);
    const match = /^(not ok|ok) \d+ - (.+?)(?:\s+#\s*(?:SKIP|TODO)\b.*)?$/.exec(line);
    if (!match) {
      if (/^#\s/.test(line) && !/^# Subtest:/.test(line)) block.push(line.replace(/^#\s?/, ''));
      continue;
    }
    if (match[1] === 'not ok') {
      const yaml: string[] = [];
      for (let inner = index + 1; inner < lines.length && defined(lines[inner]).trim() !== '...'; inner++)
        yaml.push(defined(lines[inner]));
      const context = [...block, ...yaml];
      const error =
        context.map((entry) => entry.trim()).find((entry) => ERROR_LINE.test(entry)) ??
        yaml
          .map((entry) => /^\s+error:\s*['"|>-]*\s*(.*?)['"]?$/.exec(entry)?.[1])
          .find((entry) => entry && entry !== 'test failed');
      const where = projectLocation(context);
      failed.push(
        `- **${defined(match[2]).trim()}**${where ? ` (\`${where}\`)` : ''}${error ? `\n  ${error.slice(0, 300)}` : ''}`,
      );
    }
    block = [];
  }
  const count = (status: TestCaseResult['status']) => cases.filter((entry) => entry.status === status).length;
  const parts = [`${cases.length} Tests`, `${count('passed')} bestanden`, `${count('failed')} fehlgeschlagen`];
  if (count('skipped')) parts.push(`${count('skipped')} übersprungen`);
  const hints = FAILURE_HINTS.filter(([pattern]) => pattern.test(clean)).map(([, hint]) => `**Hinweis:** ${hint}`);
  return [
    `**Testergebnis:** ${parts.join(' · ')}`,
    ...(failed.length ? [`**Fehlgeschlagen:**\n${failed.join('\n')}`] : []),
    ...hints,
  ].join('\n\n');
}
