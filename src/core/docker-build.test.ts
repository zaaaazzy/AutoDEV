import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { WORKFLOW_DOCS } from '../api/workflow-docs.js';

const root = process.cwd();

async function dockerignorePatterns(): Promise<string[]> {
  const text = await readFile(join(root, '.dockerignore'), 'utf8');
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => line.replace(/^\/+|\/+$/g, ''));
}

/** Schliesst ein Muster den Pfad aus? Ein Ordner-Muster schliesst auch alles darunter aus (wie bei Docker). */
function ignored(patterns: readonly string[], path: string): boolean {
  const segments = path.split('/');
  return patterns.some((pattern) => {
    if (pattern.startsWith('!')) return false;
    const parts = pattern.split('/');
    if (parts.length > segments.length) return false;
    return parts.every((part, i) => part === '**' || segmentMatches(part, segments[i]));
  });
}

/** `*` innerhalb eines Segments, etwa `.env.*`, steht für beliebige Zeichen ausser `/`. */
function segmentMatches(part: string, segment: string): boolean {
  const regex = part
    .split('*')
    .map((piece) => piece.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^/]*');
  return new RegExp(`^${regex}$`).test(segment);
}

test('.dockerignore schliesst Medien von test:full, Sicherungen und Laufzeitdaten aus', async () => {
  const patterns = await dockerignorePatterns();
  for (const path of [
    'docs/tests/2026-10-18_18-33/media',
    'docs/tests/2026-10-18_18-33/media/video.webm',
    'docs/tests/2026-10-18_18-33/screenshot.png',
    'backups',
    'test-results',
    'playwright-report',
    '.dev-log',
    '.dev-log-backups/merge-abbruch.patch',
    '.env',
    '.env.bak-2026-10-21',
    'e2e/test-results/video.webm',
  ]) {
    assert.ok(ignored(patterns, path), `${path} fehlt in .dockerignore`);
  }
  for (const doc of WORKFLOW_DOCS) {
    assert.ok(!ignored(patterns, `docs/${doc.file}`), `docs/${doc.file} darf nicht ausgeschlossen sein`);
  }
});

test('Dockerfile kopiert aus docs nur die Workflow-Dokumente, nicht den ganzen Ordner', async () => {
  const dockerfile = await readFile(join(root, 'Dockerfile'), 'utf8');
  const copies = dockerfile
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^COPY\s/i.test(line))
    .map((line) => line.split(/\s+/).slice(1));
  const docsSources = copies.flatMap((args) => args.slice(0, -1)).filter((source) => /^(\.\/)?docs(\/|$)/.test(source));
  const expected = WORKFLOW_DOCS.map((doc) => `docs/${doc.file}`);
  assert.deepEqual([...docsSources].sort(), [...expected].sort());
  assert.ok(copies.some((args) => args.at(-1) === './docs/' && expected.every((file) => args.includes(file))));
});
