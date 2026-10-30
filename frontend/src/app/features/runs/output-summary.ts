import { summarizeTestOutput } from '../../shared/test-output.js';
import { defined } from '../../../../../src/core/defined.js';

/** Eine Meldung aus der Ausgabe (gleiche Meldungen zusammengefasst), z. B. eine Build-Warnung mit Datei:Zeile. */
export interface OutputIssue {
  level: 'error' | 'warning';
  code: string;
  message: string;
  location: string;
  count: number;
}

/** Aufbereitete Ausgabe eines Prüfschritts: Kurzfazit, Kennzahlen, ggf. Tabelle und Meldungen. */
export interface OutputSummary {
  headline: string;
  facts: { label: string; value: string }[];
  table: { title: string; headers: string[]; rows: string[][] } | null;
  issues: OutputIssue[];
}

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const MAX_ISSUES = 30;

/** Absolute Pfade auf den Projektteil kürzen (…/DevLog/frontend/src/x.ts → frontend/src/x.ts). */
function shortPath(path: string): string {
  return path.trim().replace(/^.*?\/((?:src|frontend|e2e|scripts|docs|test|tests|lib|app)\/)/, '$1');
}

function addIssue(issues: OutputIssue[], issue: Omit<OutputIssue, 'count'>): void {
  const same = issues.find(
    (entry) => entry.code === issue.code && entry.message === issue.message && entry.location === issue.location,
  );
  if (same) same.count += 1;
  else issues.push({ ...issue, count: 1 });
}

const number = (text: string, pattern: RegExp): number | null => {
  const match = pattern.exec(text);
  return match ? Number(match[1]) : null;
};

/** Angular/esbuild: Bundle-Tabelle, Warnungen und Fehler mit Fundstelle. */
function parseBuild(lines: string[], summary: OutputSummary): boolean {
  let found = false;
  const header = lines.findIndex((line) => /^(Initial|Lazy) chunk files\s*\|/.test(line));
  if (header >= 0) {
    found = true;
    const rows: string[][] = [];
    // Die Summenzeile steht nach einer Leerzeile unter der Tabelle
    const inTable = (index: number) =>
      lines[index]?.includes('|') || (!lines[index]?.trim() && lines[index + 1]?.includes('|'));
    for (let index = header + 1; index < lines.length && inTable(index); index++) {
      if (!defined(lines[index]).trim()) continue;
      const cells = defined(lines[index])
        .split('|')
        .map((cell) => cell.trim());
      if (cells.every((cell) => !cell)) continue;
      rows.push(cells);
    }
    const headers = defined(lines[header])
      .split('|')
      .map((cell) => cell.trim());
    summary.table = { title: 'Bundle', headers: ['Datei', ...headers.slice(1)], rows };
    const total = rows.find((row) => /total/i.test(row[1] ?? ''));
    if (total) summary.facts.push({ label: 'Gesamtgröße', value: `${total[2]} (übertragen ${total[3]})` });
  }
  for (let index = 0; index < lines.length; index++) {
    const match = /^[▲✘X]\s*\[(WARNING|ERROR)\]\s*(?:(\w+\d+):\s*)?(.+?)(?:\s*\[plugin [^\]]+\])?$/.exec(
      defined(lines[index]),
    );
    if (!match) continue;
    found = true;
    const location = lines
      .slice(index + 1, index + 4)
      .map((line) => /^\s*(\S+:\d+:\d+):?\s*$/.exec(line)?.[1])
      .find(Boolean);
    addIssue(summary.issues, {
      level: match[1] === 'ERROR' ? 'error' : 'warning',
      code: match[2] ?? '',
      message: defined(match[3]).trim(),
      location: location ? shortPath(location) : '',
    });
  }
  const seconds = /bundle generation (?:complete|failed)\. \[([\d.]+) seconds\]/.exec(lines.join('\n'));
  if (seconds) {
    found = true;
    summary.facts.push({ label: 'Build', value: `${Number(seconds[1]).toFixed(1)} s` });
  }
  return found;
}

/** ESLint (stylish): Meldungen je Regel zusammengefasst, erste Fundstelle angegeben. */
function parseLint(lines: string[], summary: OutputSummary): boolean {
  const total = /✖ (\d+) problems? \((\d+) errors?, (\d+) warnings?\)/.exec(lines.join('\n'));
  let file = '';
  const byRule = new Map<string, OutputIssue>();
  for (const line of lines) {
    if (/^\/\S+$/.test(line.trim()) || /^[A-Z]:\\/.test(line.trim())) {
      file = shortPath(line.trim());
      continue;
    }
    const match = /^\s+(\d+):(\d+)\s+(error|warning)\s+(.+?)\s{2,}(\S+)\s*$/.exec(line);
    if (!match) continue;
    const key = `${match[3]}:${match[5]}`;
    const existing = byRule.get(key);
    if (existing) existing.count += 1;
    else
      byRule.set(key, {
        level: match[3] as 'error' | 'warning',
        code: defined(match[5]),
        message: defined(match[4]),
        location: `${file}:${match[1]}`,
        count: 1,
      });
  }
  if (!total && !byRule.size) return false;
  if (total) {
    summary.facts.push({ label: 'Fehler', value: defined(total[2]) }, { label: 'Warnungen', value: defined(total[3]) });
  }
  summary.issues.push(
    ...[...byRule.values()].sort((left, right) =>
      left.level === right.level ? right.count - left.count : left.level === 'error' ? -1 : 1,
    ),
  );
  return true;
}

/** TypeScript: „datei(zeile,spalte): error TSxxxx: …“. */
function parseTypeScript(lines: string[], summary: OutputSummary): boolean {
  let found = false;
  for (const line of lines) {
    const match = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.+)$/.exec(line.trim());
    if (!match) continue;
    found = true;
    addIssue(summary.issues, {
      level: 'error',
      code: defined(match[4]),
      message: defined(match[5]),
      location: `${shortPath(defined(match[1]))}:${match[2]}`,
    });
  }
  return found;
}

/** Prettier: nicht formatierte Dateien. */
function parsePrettier(lines: string[], summary: OutputSummary): boolean {
  const files = lines
    .map((line) => /^\[warn\] (.+)$/.exec(line)?.[1])
    .filter((file): file is string => !!file && !/Code style issues/.test(file));
  for (const file of files)
    addIssue(summary.issues, { level: 'warning', code: 'prettier', message: 'nicht formatiert', location: file });
  if (files.length) summary.facts.push({ label: 'Nicht formatiert', value: String(files.length) });
  return files.length > 0 || lines.some((line) => /All matched files use Prettier/.test(line));
}

/** Node-Test-Runner (TAP): Zählung und fehlgeschlagene Tests. */
function parseTap(text: string, lines: string[], summary: OutputSummary): boolean {
  const pass = number(text, /^# pass (\d+)$/m);
  const fail = number(text, /^# fail (\d+)$/m);
  if (pass === null && fail === null) return false;
  summary.facts.push(
    { label: 'Bestanden', value: String(pass ?? 0) },
    { label: 'Fehlgeschlagen', value: String(fail ?? 0) },
  );
  const skipped = number(text, /^# skipped (\d+)$/m);
  if (skipped) summary.facts.push({ label: 'Übersprungen', value: String(skipped) });
  const duration = number(text, /^# duration_ms ([\d.]+)$/m);
  if (duration !== null) summary.facts.push({ label: 'Dauer', value: `${(duration / 1000).toFixed(1)} s` });
  for (const line of lines) {
    const failed = /^not ok \d+ - (.+)$/.exec(line);
    if (failed) addIssue(summary.issues, { level: 'error', code: 'Test', message: defined(failed[1]), location: '' });
  }
  return true;
}

/** Playwright (list-Reporter): Zählung und fehlgeschlagene Tests je Gerät. */
function parsePlaywright(text: string, lines: string[], summary: OutputSummary): boolean {
  const passed = number(text, /^\s*(\d+) passed/m);
  const failed = number(text, /^\s*(\d+) failed/m);
  if (passed === null && failed === null) return false;
  summary.facts.push(
    { label: 'Bestanden', value: String(passed ?? 0) },
    { label: 'Fehlgeschlagen', value: String(failed ?? 0) },
  );
  const skipped = number(text, /^\s*(\d+) skipped/m);
  if (skipped) summary.facts.push({ label: 'Übersprungen', value: String(skipped) });
  for (const line of lines) {
    const match = /^\s*✘\s+\d+\s+\[([^\]]+)\]\s+›\s+(\S+?):\d+:\d+\s+›\s+(.+?)(?:\s+\([\d.]+m?s\))?\s*$/.exec(line);
    if (match)
      addIssue(summary.issues, {
        level: 'error',
        code: defined(match[1]),
        message: defined(match[3]),
        location: shortPath(defined(match[2])),
      });
  }
  return true;
}

/** Bereitet die Ausgabe eines Prüfschritts auf; unbekannte Ausgaben bekommen nur ein Kurzfazit. */
export function summarizeOutput(command: string, output: string, status: string): OutputSummary {
  const text = output.replace(ANSI, '');
  const lines = text.split(/\r?\n/);
  const summary: OutputSummary = { headline: '', facts: [], table: null, issues: [] };
  const lint = /\blint\b|eslint/.test(command) && parseLint(lines, summary);
  const format = /format|prettier/.test(command) && parsePrettier(lines, summary);
  const types = parseTypeScript(lines, summary);
  const build = parseBuild(lines, summary);
  const tap = parseTap(text, lines, summary);
  const playwright = !tap && parsePlaywright(text, lines, summary);
  const errors = summary.issues.filter((issue) => issue.level === 'error').reduce((sum, issue) => sum + issue.count, 0);
  const warnings = summary.issues
    .filter((issue) => issue.level === 'warning')
    .reduce((sum, issue) => sum + issue.count, 0);
  const parts: string[] = [];
  if (tap || playwright) {
    const passed = summary.facts.find((fact) => fact.label === 'Bestanden')?.value ?? '0';
    const failed = Number(summary.facts.find((fact) => fact.label === 'Fehlgeschlagen')?.value ?? 0);
    parts.push(failed ? `${failed} Tests fehlgeschlagen, ${passed} bestanden` : `${passed} Tests bestanden`);
  }
  // ESLint nennt die Summen selbst; die Einzelmeldungen können gekürzt sein
  const lintErrors = Number(summary.facts.find((fact) => fact.label === 'Fehler')?.value ?? errors);
  const lintWarnings = Number(summary.facts.find((fact) => fact.label === 'Warnungen')?.value ?? warnings);
  if (lint) parts.push(lintErrors ? `${lintErrors} Lint-Fehler` : 'keine Lint-Fehler');
  if (format)
    parts.push(summary.issues.length ? `${summary.issues.length} Dateien nicht formatiert` : 'alles formatiert');
  if (types && !lint) parts.push(`${errors} Typfehler`);
  if (/typecheck|tsc/.test(command) && !types) parts.push('keine Typfehler');
  if (build) parts.push(errors && !types && !tap ? `Build mit ${errors} Fehlern` : 'Build erstellt');
  const shownWarnings = lint ? lintWarnings : warnings;
  if (shownWarnings && !format) parts.push(`${shownWarnings} ${shownWarnings === 1 ? 'Warnung' : 'Warnungen'}`);
  summary.headline = parts.join(' · ') || summarizeTestOutput(text, status);
  summary.issues = summary.issues.slice(0, MAX_ISSUES);
  return summary;
}
