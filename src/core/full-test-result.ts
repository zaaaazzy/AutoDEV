import type { TestCaseResult, TestCategory } from './test-results.js';

/**
 * Ergebnis eines Komplettlaufs (npm run test:full) als Datei: Im Testcontainer (Sandbox) gibt es keinen Zugang zur
 * AIdeation-Datenbank. test:full schreibt dann Schritte, Einzeltests und Medienpfade in diese Datei, und der Worker
 * legt den Testlauf auf dem Host an (runner/test-import.ts). Medienpfade sind relativ zum Projektordner.
 */
export interface FullTestStep {
  name: string;
  command: string;
  category: TestCategory;
  ok: boolean;
  seconds: number;
  summary: string;
  tail: string;
  cases: TestCaseResult[];
}

export interface FullTestResult {
  version: 1;
  startedAt: string;
  platform: string;
  passed: boolean;
  steps: FullTestStep[];
}

/** Ablage der Ergebnisdatei je Testanforderung (relativ zum Projektordner, in .gitignore über test-results/). */
export const fullTestResultFile = (requestId: string): string =>
  `test-results/aideation-anfrage-${requestId.replace(/[^a-zA-Z0-9-]/g, '')}.json`;

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
export function documentReport(
  results: Pick<FullTestStep, 'name' | 'ok' | 'seconds' | 'summary' | 'cases'>[],
  allOk: boolean,
  runId: string,
  started: Date,
): string {
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
