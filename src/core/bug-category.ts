import { defined } from './defined.js';

/**
 * Kategorie eines Bugs aus den betroffenen Dateipfaden (rein, deterministisch). Pfade unter `frontend/` gelten als
 * Frontend, unter `src/` als Backend, beides zusammen als Fullstack. Nur Pfade des Agent-Wächters, der Pfadregeln und
 * der Rechte (`src/agent/agent-guard`, `src/agent/path-policy`, `src/agent/permission…`) sind Sicherheit; Betrieb
 * (`deploy/`, Dockerfile, Compose) ist Infrastruktur, `docs/` Dokumentation. Ohne eindeutige Zuordnung: null.
 */
export const BUG_CATEGORIES = ['frontend', 'backend', 'fullstack', 'infrastructure', 'docs', 'security'] as const;
export type BugCategory = (typeof BUG_CATEGORIES)[number];

type Area = 'frontend' | 'backend' | 'security' | 'infrastructure' | 'docs';

/** Ordner, an denen ein Pfad im Projekt beginnt (auch mitten in einem absoluten Pfad oder Stacktrace). */
const ROOTS = ['frontend', 'src', 'deploy', 'docs', '.github'];
const ROOT_FILES = new Set(['dockerfile', 'docker-compose.yml', 'docker-compose.yaml', 'start.sh', 'start.cmd']);
/** Sicherheitsrelevante Module unter src/agent – nur als ganzes Pfadsegment (Name ohne Endung), nie als Teilstring. */
const SECURITY_MODULE = /^(?:agent-guard|path-policy|permissions?(?:-[a-z0-9]+)*)$/;
const MAX_PATHS = 200;

export function isBugCategory(value: unknown): value is BugCategory {
  return typeof value === 'string' && (BUG_CATEGORIES as readonly string[]).includes(value);
}

/** Pfad vereinheitlichen: Schrägstriche, `file://`, Zeile/Spalte am Ende und Satzzeichen weg; ab dem Projektordner. */
function projectPath(raw: string): string[] | null {
  const cleaned = raw
    .replace(/\\/g, '/')
    .replace(/^file:\/\//, '')
    .replace(/[)\]}>.,;:'"`]+$/, '')
    .replace(/(?::\d+)+$/, '');
  const segments = cleaned.split('/').filter((segment) => segment && segment !== '.');
  if (segments.includes('node_modules') || segments.includes('..')) return null;
  const start = segments.findIndex((segment) => ROOTS.includes(segment));
  if (start >= 0) return segments.slice(start);
  const last = segments.at(-1)?.toLowerCase();
  return last && segments.length === 1 && (ROOT_FILES.has(last) || last === 'readme.md') ? [last] : null;
}

function areaOf(raw: string): Area | null {
  const segments = projectPath(raw);
  if (!segments) return null;
  const [root, second, third] = segments;
  if (root === 'frontend') return 'frontend';
  if (root === 'src') {
    const module = third?.split('.')[0];
    return second === 'agent' && module && SECURITY_MODULE.test(module) ? 'security' : 'backend';
  }
  if (root === 'deploy' || root === '.github' || ROOT_FILES.has(defined(root))) return 'infrastructure';
  if (root === 'docs' || root === 'readme.md') return 'docs';
  return null;
}

/**
 * Kategorie aus Pfaden: Frontend und Backend (auch Sicherheitsmodule unter src/) zusammen → Fullstack; nur
 * Sicherheitsmodule → Sicherheit; Doku zählt neben Code nicht mit. Code zusammen mit Betrieb ist nicht eindeutig.
 */
export function categoryFromPaths(paths: readonly string[]): BugCategory | null {
  const areas = new Set(
    paths
      .slice(0, MAX_PATHS)
      .map(areaOf)
      .filter((area): area is Area => area !== null),
  );
  const frontend = areas.has('frontend');
  const backend = areas.has('backend') || areas.has('security');
  if (areas.has('infrastructure')) return frontend || backend ? null : 'infrastructure';
  if (frontend && backend) return 'fullstack';
  if (frontend) return 'frontend';
  if (areas.has('backend')) return 'backend';
  if (areas.has('security')) return 'security';
  return areas.has('docs') ? 'docs' : null;
}

/** Dateipfade, die ein Text nennt (Testdateien, Stacktraces, Befunde) – Kandidaten für categoryFromPaths. */
export function pathsInText(text: string): string[] {
  const found = new Set<string>();
  for (const token of text.split(/[\s`'"()[\]<>|*,]+/)) {
    if (found.size >= MAX_PATHS) break;
    if (!token.includes('/')) continue;
    if (/^[a-z]+:\/\//i.test(token) && !token.startsWith('file://')) continue;
    // Im Fliesstext nur echte Dateipfade (mit Datei oder Unterordner), nicht „frontend/backend“ oder „src/“.
    const segments = projectPath(token);
    const last = segments?.at(-1) ?? '';
    const fileLike = segments && segments.length >= 2 && (segments.length >= 3 || /\.|^[A-Z]/.test(last));
    if (fileLike && areaOf(token)) found.add(token);
  }
  return [...found];
}

/** Kategorie aus ausdrücklichen Pfaden und den im Text genannten. */
export function categoryFromBug(bug: {
  title: string;
  description: string;
  paths?: readonly string[];
}): BugCategory | null {
  return categoryFromPaths([...(bug.paths ?? []), ...pathsInText(`${bug.title}\n${bug.description}`)]);
}

/** Antwort des Modells: genau einer der sechs Werte (auch als JSON {"category": …}); alles andere → null. */
export function parseModelCategory(answer: string): BugCategory | null {
  let text = answer.trim();
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === 'object' && 'category' in parsed) text = String(parsed.category);
    else if (typeof parsed === 'string') text = parsed;
  } catch {
    // Klartext
  }
  const value = text
    .trim()
    .toLowerCase()
    .replace(/^["'`]+|["'`.]+$/g, '');
  return isBugCategory(value) ? value : null;
}
