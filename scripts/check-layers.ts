/**
 * Schichtenprüfung (Teil von `npm run lint`): Importe in src/ dürfen nur in die eigene oder eine tiefere Schicht
 * zeigen (core ← db ← agent ← runner ← setup ← api), und es darf keine Import-Zyklen geben. Bekannte Verstösse stehen
 * mit Begründung in scripts/check-layers.baseline.json; neue brechen den Lauf ab, behobene müssen aus der Baseline
 * raus. `--write-baseline` schreibt den Ist-Stand in die Baseline (bestehende Begründungen bleiben).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type BaselineEntry, collectEdges, evaluate, LAYERS, rebuildBaseline } from './lib/layers.js';

const root = process.cwd();
const baselineFile = join(root, 'scripts', 'check-layers.baseline.json');

function readBaseline(): BaselineEntry[] {
  try {
    return JSON.parse(readFileSync(baselineFile, 'utf8')) as BaselineEntry[];
  } catch {
    return [];
  }
}

const edges = collectEdges(root);
const baseline = readBaseline();

if (process.argv.includes('--write-baseline')) {
  const next = rebuildBaseline(edges, baseline);
  writeFileSync(baselineFile, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`Baseline geschrieben: ${next.length} geduldete Verstösse.`);
  process.exit(0);
}

const result = evaluate(edges, baseline);
let failed = false;

if (result.violations.length) {
  failed = true;
  console.error(`Schichtenregel verletzt (${LAYERS.join(' ← ')}):`);
  for (const edge of result.violations) console.error(`  ${edge.from} → ${edge.to}`);
  console.error(
    '  Fachlogik in eine tiefere Schicht verschieben (z. B. nach src/db oder src/core) statt nach oben zu importieren.',
  );
}
if (result.stale.length) {
  failed = true;
  console.error('Baseline-Einträge ohne Verstoss (aus scripts/check-layers.baseline.json streichen):');
  for (const entry of result.stale) console.error(`  ${entry.from} → ${entry.to}`);
}
if (result.cycles.length) {
  failed = true;
  console.error('Import-Zyklen:');
  for (const cycle of result.cycles) console.error(`  ${cycle.length} Dateien: ${cycle.join(', ')}`);
}

if (failed) process.exit(1);
console.log(`Schichten in Ordnung: ${edges.length} Importe, ${baseline.length} geduldete Verstösse, keine Zyklen.`);
