import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { Pool } from 'pg';
import { syncRepoDocs } from './docs.js';

const base = await mkdtemp(join(tmpdir(), 'docs-sync-'));
after(() => rm(base, { recursive: true, force: true }));

function recordingPool(): { pool: Pool; saved: Map<string, string> } {
  const saved = new Map<string, string>();
  const pool = {
    query: async (_sql: string, params: unknown[]) => {
      saved.set(params[2] as string, params[3] as string);
      return { rows: [] };
    },
  };
  return { pool: pool as unknown as Pool, saved };
}

test('Repo-Doku-Sync: Symlinks (Datei, Ordner, ins Leere) landen nicht in docs, normale Dateien schon', async () => {
  const repo = join(base, 'repo');
  const outside = join(base, 'outside');
  await mkdir(join(repo, 'docs'), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, 'id_rsa'), 'GEHEIM');
  await writeFile(join(repo, 'README.md'), '# Projekt');
  await writeFile(join(repo, 'docs', 'ok.md'), '# Ok');
  await symlink(join(outside, 'id_rsa'), join(repo, 'docs', 'x.md'));
  await symlink(join(outside, 'fehlt'), join(repo, 'docs', 'leer.md'));
  await symlink(outside, join(repo, 'docs', 'sub.md'));

  const { pool, saved } = recordingPool();
  assert.equal(await syncRepoDocs(pool, 'demo', repo), 2);
  assert.deepEqual([...saved.keys()].sort(), ['README.md', join('docs', 'ok.md')]);
  assert.ok(![...saved.values()].some((content) => content.includes('GEHEIM')));
});

test('Repo-Doku-Sync: verlinkter docs-Ordner wird nicht gespiegelt', async () => {
  const repo = join(base, 'repo-docs-link');
  const outside = join(base, 'outside-docs');
  await mkdir(repo, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, 'geheim.md'), 'GEHEIM');
  await symlink(outside, join(repo, 'docs'));
  const { pool, saved } = recordingPool();
  assert.equal(await syncRepoDocs(pool, 'demo', repo), 0);
  assert.equal(saved.size, 0);
});
