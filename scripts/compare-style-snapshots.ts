import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { defined } from '../src/core/defined.js';

/**
 * Vergleicht zwei Läufe von e2e/styles-snapshot.check.ts (npm run check:styles):
 *   npx tsx scripts/compare-style-snapshots.ts <vorher> <nachher> [<vorher, zweiter Lauf>]
 * Meldet je Zustand die Elemente, deren berechnete Styles sich geändert haben, und die Zahl abweichender Pixel.
 * Mit einem zweiten Vorher-Lauf zählen Abweichungen, die schon zwischen den beiden Vorher-Läufen bestehen, als
 * Rauschen (z. B. Textbreiten von Zeitangaben der Beispieldaten) und werden nicht gemeldet. Pixel sind nur Hinweis:
 * Exit-Code 1 gibt es bei Style-Abweichungen und fehlenden oder zusätzlichen Elementen.
 */

interface Snapshot {
  width: number;
  styles: string[];
  elements: [string, number, number, number][];
}

const [before, after, noise] = process.argv.slice(2);
if (!before || !after) {
  console.error('Aufruf: compare-style-snapshots.ts <vorher> <nachher>');
  process.exit(2);
}
const LIMIT = Number(process.env.STYLE_DIFF_LIMIT ?? 12);
/** Klassen, die nur im zweiten Lauf hinzukommen (z. B. neue Hilfsklassen): beim Zuordnen der Elemente ignoriert. */
const IGNORED_CLASSES = (process.env.STYLE_IGNORE_CLASSES ?? '').split(',').filter(Boolean);
const withoutIgnored = (key: string) =>
  IGNORED_CLASSES.reduce((text, name) => text.replace(new RegExp(`\\.${name}(?=[.:])`, 'g'), ''), key);
/** Folgen anderer Änderungen (Größe, Position): stehen in der Ausgabe hinten, Ursachen vorne. */
const DERIVED = new Set([
  'block-size',
  'height',
  'inline-size',
  'width',
  'perspective-origin',
  'transform-origin',
  'grid-template-rows',
  'grid-template-columns',
  'top',
  'right',
  'bottom',
  'left',
  'inset-block-start',
  'inset-block-end',
  'inset-inline-start',
  'inset-inline-end',
]);

function parse(style: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const part of style.split(';')) {
    const colon = part.indexOf(':');
    if (colon > 0) map.set(part.slice(0, colon), part.slice(colon + 1));
  }
  return map;
}

function changedProperties(a: string, b: string): string[] {
  if (a === b) return [];
  const left = parse(a);
  const right = parse(b);
  const names = new Set([...left.keys(), ...right.keys()]);
  return [...names].filter((name) => left.get(name) !== right.get(name));
}

function load(dir: string, device: string, file: string): Snapshot | null {
  const full = join(dir, device, file);
  return existsSync(full) ? (JSON.parse(readFileSync(full, 'utf8')) as Snapshot) : null;
}

/** Je Element und Pseudo-Element die Eigenschaften, die sich zwischen den beiden Vorher-Läufen unterscheiden. */
function noisy(a: Snapshot, b: Snapshot | null): Set<string> {
  const result = new Set<string>();
  if (!b) return result;
  const right = new Map(b.elements.map((element) => [element[0], element]));
  for (const element of a.elements) {
    const other = right.get(element[0]);
    if (!other) continue;
    for (const slot of [1, 2, 3] as const)
      for (const name of changedProperties(defined(a.styles[element[slot]]), defined(b.styles[other[slot]])))
        result.add(`${element[0]}|${slot}|${name}`);
  }
  return result;
}

function pixelDiff(fileA: string, fileB: string): string {
  if (!existsSync(fileA) || !existsSync(fileB)) return 'Screenshot fehlt';
  const a = PNG.sync.read(readFileSync(fileA));
  const b = PNG.sync.read(readFileSync(fileB));
  if (a.width !== b.width || a.height !== b.height) return `Größe ${a.width}×${a.height} → ${b.width}×${b.height}`;
  if (a.data.equals(b.data)) return '';
  let changed = 0;
  for (let index = 0; index < a.data.length; index += 4) {
    if (
      a.data[index] !== b.data[index] ||
      a.data[index + 1] !== b.data[index + 1] ||
      a.data[index + 2] !== b.data[index + 2] ||
      a.data[index + 3] !== b.data[index + 3]
    )
      changed++;
  }
  return changed ? `${changed} Pixel` : '';
}

let failures = 0;
for (const device of readdirSync(before)) {
  for (const file of readdirSync(join(before, device)).filter((name) => name.endsWith('.json'))) {
    const name = `${device}/${file.replace('.json', '')}`;
    const otherFile = join(after, device, file);
    if (!existsSync(otherFile)) {
      console.log(`✗ ${name}: fehlt im zweiten Lauf`);
      failures++;
      continue;
    }
    const a = defined(load(before, device, file));
    const b = defined(load(after, device, file));
    const ignored = noisy(a, noise ? load(noise, device, file) : null);
    const right = new Map(b.elements.map((element) => [withoutIgnored(element[0]), element]));
    const lines: { text: string; cause: boolean }[] = [];
    let missing = 0;
    for (const element of a.elements) {
      const other = right.get(element[0]);
      if (!other) {
        missing++;
        continue;
      }
      for (const [slot, pseudo] of [
        [1, ''],
        [2, '::before'],
        [3, '::after'],
      ] as const) {
        const old = parse(defined(a.styles[element[slot]]));
        const now = parse(defined(b.styles[other[slot]]));
        const names = changedProperties(defined(a.styles[element[slot]]), defined(b.styles[other[slot]])).filter(
          (name) => !ignored.has(`${element[0]}|${slot}|${name}`),
        );
        if (!names.length) continue;
        const changes = names.map((name) => `${name}: ${old.get(name)} → ${now.get(name)}`);
        lines.push({
          text: `  ${element[0].split('>').slice(-3).join(' > ') || element[0]}${pseudo}\n    ${changes.join('\n    ')}`,
          cause: names.some((name) => !DERIVED.has(name)),
        });
      }
    }
    const png = file.replace('.json', '.png');
    const pixels = pixelDiff(join(before, device, png), join(after, device, png));
    const noisePixels = noise ? pixelDiff(join(before, device, png), join(noise, device, png)) : '';
    const pixelNote = pixels ? `${pixels}${noise ? ` (Rauschen ${noisePixels || '0 Pixel'})` : ''}` : 'Pixel gleich';
    const extra = b.elements.length - a.elements.length;
    if (!lines.length && !missing && !extra) {
      console.log(`✓ ${name}${pixels ? ` – ${pixelNote}` : ''}`);
      continue;
    }
    failures++;
    console.log(
      `✗ ${name}: ${lines.length} Style-Abweichungen, ${missing} Elemente fehlen, ${extra >= 0 ? '+' : ''}${extra} Elemente, ${pixelNote}`,
    );
    lines.sort((x, y) => Number(y.cause) - Number(x.cause));
    for (const line of lines.slice(0, LIMIT)) console.log(line.text);
    if (lines.length > LIMIT) console.log(`  … ${lines.length - LIMIT} weitere`);
  }
}
process.exit(failures ? 1 : 0);
