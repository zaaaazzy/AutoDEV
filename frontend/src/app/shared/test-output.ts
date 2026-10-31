import { defined } from '../../../../src/core/defined.js';

/** Ein Befehl aus einem gespeicherten Testlauf („$ npm test → passed“) mit Kurzfazit statt Rohausgabe. */
export interface TestStep {
  command: string;
  status: string;
  summary: string;
  raw: string;
}

const STEP_LINE = /^\$ (.+?) → (passed|failed|running|skipped|cancelled)\b\s*(.*)$/;
// Abschnitte des Agent-Berichts („## …“) beenden die Rohausgabe; TAP-Zeilen („# Subtest“) gehören noch dazu.
const END_LINE = /^(#{2,3} |Abnahme nicht bestanden$|Von dir zu prüfen$)/;

const count = (raw: string, pattern: RegExp): number | null => {
  const match = raw.match(pattern);
  return match ? Number(match[1]) : null;
};

/** Fasst die Rohausgabe eines Test- oder Build-Befehls in wenigen Worten zusammen. */
export function summarizeTestOutput(raw: string, status: string): string {
  // Node-Test-Runner (TAP: „# tests 69“, „ℹ pass 69“), Jest („69 total“) und Vitest („134 passed (136)“).
  const total =
    count(raw, /^\s*(?:#|ℹ)\s*tests\s+(\d+)/im) ??
    count(raw, /Tests:.*?(\d+)\s+total/i) ??
    count(raw, /Tests\s.*\((\d+)\)/i);
  const passed = count(raw, /^\s*(?:#|ℹ)\s*pass\s+(\d+)/im) ?? count(raw, /(\d+)\s+passed/i);
  const failed = count(raw, /^\s*(?:#|ℹ)\s*fail\s+(\d+)/im) ?? count(raw, /(\d+)\s+failed/i);
  if (total !== null || passed !== null) {
    const all = total ?? (passed ?? 0) + (failed ?? 0);
    return failed ? `${all} Tests · ${failed} fehlgeschlagen` : `${all} Tests · alle bestanden`;
  }
  const image = raw.match(/Image\s+(\S+)\s+Built/i) ?? raw.match(/naming to (?:docker\.io\/library\/)?(\S+)/i);
  if (image) return `Image ${defined(image[1]).replace(/:latest$/, '')} gebaut`;
  if (status === 'passed') return 'erfolgreich';
  const error = raw
    .split('\n')
    .map((line) => line.trim())
    .find((line) => /error|fehler|fail|✕|not ok|exception/i.test(line));
  const last = raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
  const text = error ?? last ?? 'fehlgeschlagen';
  return text.length > 140 ? `${text.slice(0, 139)}…` : text;
}

/** Zerlegt einen Text in normale Abschnitte und Testlauf-Befehle; die Zeile „Testlauf <id>“ entfällt. */
export function splitTestSteps(text: string): (string | TestStep)[] {
  const parts: (string | TestStep)[] = [];
  let plain: string[] = [];
  let step: { command: string; status: string; raw: string[] } | null = null;
  const flushStep = (): void => {
    if (!step) return;
    const raw = step.raw.join('\n').trim();
    parts.push({ command: step.command, status: step.status, raw, summary: summarizeTestOutput(raw, step.status) });
    step = null;
  };
  for (const line of text.split(/\r?\n/)) {
    if (/^Testlauf [0-9a-f-]{36}\s*$/i.test(line)) continue;
    const start = line.match(STEP_LINE);
    if (start) {
      flushStep();
      if (plain.length) parts.push(plain.join('\n'));
      plain = [];
      step = { command: defined(start[1]).trim(), status: defined(start[2]), raw: start[3] ? [start[3]] : [] };
      continue;
    }
    if (step && END_LINE.test(line)) flushStep();
    if (step) step.raw.push(line);
    else plain.push(line);
  }
  flushStep();
  if (plain.length) parts.push(plain.join('\n'));
  return parts;
}
