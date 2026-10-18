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

/**
 * Einzeltests aus TAP (node --test, tsx --test): nur Tests der obersten Ebene, mit Dauer und Fehlermeldung
 * aus dem YAML-Block. Unterschiedlich eingerückte Untertests werden ihrem Elterntest zugerechnet.
 */
export function parseTapCases(output: string): TestCaseResult[] {
  const lines = output.replace(ANSI, '').split('\n');
  const cases: TestCaseResult[] = [];
  for (let index = 0; index < lines.length; index++) {
    const match = /^(not ok|ok) \d+ - (.+?)(?:\s+#\s*(SKIP|TODO)\b.*)?$/.exec(lines[index]!);
    if (!match) continue;
    let durationMs: number | null = null;
    const errors: string[] = [];
    if (lines[index + 1]?.trim() === '---') {
      for (let inner = index + 2; inner < lines.length && lines[inner]!.trim() !== '...'; inner++) {
        const line = lines[inner]!;
        const duration = /^\s+duration_ms:\s*([\d.]+)/.exec(line);
        if (duration) durationMs = Math.round(Number(duration[1]));
        const error = /^\s+error:\s*(.*)$/.exec(line);
        if (error) {
          const quoted = error[1]!.replace(/^['"|>-]+\s*/, '').replace(/['"]$/, '');
          const next = quoted || lines[inner + 1]?.trim() || '';
          if (next && errors.length < MAX_ERRORS) errors.push(cleanError(next));
        }
      }
    }
    const skipped = Boolean(match[3]);
    cases.push({
      category: 'unit',
      title: match[2]!.trim(),
      file: null,
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
