// Schichtenregel für src/: Welche Ordner dürfen welche importieren, und wo gibt es Import-Zyklen.
// Reine Funktionen ohne Prozess-Zustand; der Aufruf steht in scripts/check-layers.ts, die Tests in scripts/layers.test.ts.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, posix, relative, resolve, sep } from 'node:path';

/**
 * Schichten von unten nach oben. Eine Datei darf nur ihre eigene Schicht und tiefere importieren:
 * core (Hilfen ohne HTTP und Runner) ← db (Schema, Datenzugriff) ← agent (Agents, Rechte) ← runner (Worker) ←
 * setup (Einrichtung, Vorlagen) ← api (Express-Routen). `server.ts` und `dev-server.ts` liegen darüber.
 */
export const LAYERS = ['core', 'db', 'agent', 'runner', 'setup', 'api'] as const;
export type Layer = (typeof LAYERS)[number];

/** Import von `from` nach `to`, beide als Pfade relativ zum Projektordner mit `/`. */
export interface ImportEdge {
  from: string;
  to: string;
}

/** Bekannte, geduldete Verstösse; jeder mit Begründung, damit er irgendwann verschwindet. */
export interface BaselineEntry extends ImportEdge {
  why: string;
}

export interface ParsedImport {
  specifier: string;
  /** Nur Typen: TypeScript entfernt den Import beim Kompilieren, er erzeugt keine Abhängigkeit zur Laufzeit. */
  typeOnly: boolean;
}

const STATIC_IMPORT = /^\s*(import|export)\s+(type\s+)?(?:([^'";]*?)\s+from\s+)?['"]([^'"]+)['"]/gm;
const DYNAMIC_IMPORT = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;

/** Alle relativen Importe einer Datei (statisch, Re-Export, dynamisch) mit der Angabe, ob nur Typen betroffen sind. */
export function parseImports(source: string): ParsedImport[] {
  const found: ParsedImport[] = [];
  for (const match of source.matchAll(STATIC_IMPORT)) {
    const [, keyword, typeKeyword, clause, specifier] = match;
    if (!specifier || !specifier.startsWith('.')) continue;
    // `import './x.js'` (nur Seiteneffekt) hat keine Klausel und zählt zur Laufzeit.
    if (keyword === 'import' && clause === undefined) {
      found.push({ specifier, typeOnly: false });
      continue;
    }
    if (clause === undefined) continue;
    found.push({ specifier, typeOnly: Boolean(typeKeyword) || allSpecifiersTypeOnly(clause) });
  }
  for (const match of source.matchAll(DYNAMIC_IMPORT)) {
    const specifier = match[1];
    if (specifier?.startsWith('.')) found.push({ specifier, typeOnly: false });
  }
  return found;
}

/** `{ type A, type B }` ohne Standard- oder Namensraum-Import: TypeScript lässt den ganzen Import weg. */
function allSpecifiersTypeOnly(clause: string): boolean {
  const braces = /^\s*\{([^}]*)\}\s*$/.exec(clause);
  if (!braces) return false;
  const names = (braces[1] ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  return names.length > 0 && names.every((name) => /^type\s+/.test(name));
}

/** Schicht einer Datei (`src/core/x.ts` → core); null für Dateien direkt in src/ (Einstiege) oder ausserhalb. */
export function layerOf(file: string): Layer | null {
  const parts = file.split('/');
  if (parts[0] !== 'src' || parts.length < 3) return null;
  const layer = parts[1] as Layer;
  return LAYERS.includes(layer) ? layer : null;
}

/** Zielpfad eines relativen Imports (`.js` → `.ts`), relativ zum Projektordner. */
export function resolveImport(from: string, specifier: string): string {
  const target = posix.join(posix.dirname(from), specifier);
  return target.replace(/\.js$/, '.ts');
}

function walk(dir: string, files: string[]): void {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, files);
    else if (path.endsWith('.ts') && !path.endsWith('.test.ts') && !path.endsWith('.d.ts')) files.push(path);
  }
}

/** Laufzeit-Importe aller Produktionsdateien unter `root/src` (ohne Tests und Typdeklarationen). */
export function collectEdges(root: string): ImportEdge[] {
  const files: string[] = [];
  walk(resolve(root, 'src'), files);
  const edges: ImportEdge[] = [];
  for (const file of files) {
    const from = relative(root, file).split(sep).join('/');
    for (const entry of parseImports(readFileSync(file, 'utf8'))) {
      if (entry.typeOnly) continue;
      edges.push({ from, to: resolveImport(from, entry.specifier) });
    }
  }
  return edges;
}

/** Importe von einer tieferen in eine höhere Schicht. Einstiege (`src/server.ts`) dürfen alles importieren. */
export function layerViolations(edges: readonly ImportEdge[]): ImportEdge[] {
  return edges.filter((edge) => {
    const from = layerOf(edge.from);
    const to = layerOf(edge.to);
    if (!from || !to) return false;
    return LAYERS.indexOf(to) > LAYERS.indexOf(from);
  });
}

/**
 * Stark zusammenhängende Komponenten mit mehr als einer Datei (Tarjan): jede ist ein Import-Zyklus. Zyklen machen die
 * Startreihenfolge der Module zufällig und ziehen beim Testen einer Datei den ganzen Ring mit.
 */
export function findCycles(edges: readonly ImportEdge[]): string[][] {
  const graph = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (!graph.has(edge.from)) graph.set(edge.from, new Set());
    if (!graph.has(edge.to)) graph.set(edge.to, new Set());
    graph.get(edge.from)?.add(edge.to);
  }
  let counter = 0;
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const cycles: string[][] = [];
  const visit = (node: string): void => {
    index.set(node, counter);
    low.set(node, counter);
    counter += 1;
    stack.push(node);
    onStack.add(node);
    for (const next of graph.get(node) ?? []) {
      if (!index.has(next)) {
        visit(next);
        low.set(node, Math.min(low.get(node) ?? 0, low.get(next) ?? 0));
      } else if (onStack.has(next)) {
        low.set(node, Math.min(low.get(node) ?? 0, index.get(next) ?? 0));
      }
    }
    if (low.get(node) !== index.get(node)) return;
    const component: string[] = [];
    for (;;) {
      const member = stack.pop();
      if (member === undefined) break;
      onStack.delete(member);
      component.push(member);
      if (member === node) break;
    }
    if (component.length > 1) cycles.push(component.sort());
  };
  for (const node of [...graph.keys()].sort()) if (!index.has(node)) visit(node);
  return cycles.sort((a, b) => b.length - a.length || (a[0] ?? '').localeCompare(b[0] ?? ''));
}

export interface Evaluation {
  /** Verstösse gegen die Schichtenregel, die nicht in der Baseline stehen. */
  violations: ImportEdge[];
  /** Baseline-Einträge, die es nicht mehr gibt: aus der Baseline streichen, damit sie nicht zurückkommen. */
  stale: BaselineEntry[];
  cycles: string[][];
}

const key = (edge: ImportEdge): string => `${edge.from} -> ${edge.to}`;

/** Prüft Kanten gegen Schichtenregel und Baseline; Zyklen sind nie geduldet. */
export function evaluate(edges: readonly ImportEdge[], baseline: readonly BaselineEntry[]): Evaluation {
  const found = layerViolations(edges);
  const foundKeys = new Set(found.map(key));
  const known = new Set(baseline.map(key));
  return {
    violations: found.filter((edge) => !known.has(key(edge))),
    stale: baseline.filter((entry) => !foundKeys.has(key(entry))),
    cycles: findCycles(edges),
  };
}

/** Neue Baseline aus dem Ist-Stand; Begründungen bekannter Einträge bleiben, neue bekommen „TODO“. */
export function rebuildBaseline(edges: readonly ImportEdge[], previous: readonly BaselineEntry[]): BaselineEntry[] {
  const reasons = new Map(previous.map((entry) => [key(entry), entry.why]));
  return layerViolations(edges)
    .map((edge) => ({ ...edge, why: reasons.get(key(edge)) ?? 'TODO: Begründung ergänzen oder Verstoss beheben.' }))
    .sort((a, b) => key(a).localeCompare(key(b)));
}
