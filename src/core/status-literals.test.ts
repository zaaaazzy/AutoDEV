import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../..');

/** Status-Werte, die nirgends sonst als Text vorkommen: ein Treffer ist immer ein Verstoss gegen die Regel in CLAUDE.md. */
const UNIQUE_STATUS_LITERALS = /'(in_progress|backlog|wontfix|drafting|considering)'/g;

/** Hier stehen die Werte selbst bzw. die eingefrorene Schema-Historie. */
const ALLOWED = new Set(['src/core/status.ts', 'src/db/schema.ts', 'src/db/migrations.ts']);

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    if (statSync(path).isDirectory()) yield* sourceFiles(path);
    else if (/\.ts$/.test(entry) && !/\.(test|spec|d)\.ts$/.test(entry)) yield path;
  }
}

test('Status-Werte stehen im Backend nur in src/core/status.ts, nicht als Literal im Code oder in SQL', () => {
  const hits: string[] = [];
  for (const file of sourceFiles(join(ROOT, 'src'))) {
    const name = relative(ROOT, file);
    if (ALLOWED.has(name)) continue;
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => {
      if (UNIQUE_STATUS_LITERALS.test(line)) hits.push(`${name}:${index + 1}: ${line.trim()}`);
      UNIQUE_STATUS_LITERALS.lastIndex = 0;
    });
  }
  assert.deepEqual(
    hits,
    [],
    `Status-Literale gefunden – stattdessen DEVELOPMENT_STATUS/BUG_STATUS/IDEATION_STATUS aus src/core/status.ts verwenden:\n${hits.join('\n')}`,
  );
});
