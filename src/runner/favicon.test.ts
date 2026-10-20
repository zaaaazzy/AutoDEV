import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Pool } from 'pg';
import { findFavicon, syncFavicon } from './favicon.js';

test('finds the favicon at the usual places, otherwise by a shallow search', async () => {
  const root = await mkdtemp(join(tmpdir(), 'favicon-'));
  assert.equal(await findFavicon(root), null);
  await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true });
  await writeFile(join(root, 'node_modules', 'pkg', 'favicon.ico'), 'x');
  assert.equal(await findFavicon(root), null, 'node_modules is ignored');
  await mkdir(join(root, 'apps', 'web', 'assets'), { recursive: true });
  await writeFile(join(root, 'apps', 'web', 'assets', 'favicon.png'), 'x');
  assert.equal(await findFavicon(root), join(root, 'apps', 'web', 'assets', 'favicon.png'));
  await mkdir(join(root, 'frontend', 'public'), { recursive: true });
  await writeFile(join(root, 'frontend', 'public', 'favicon.ico'), 'x');
  assert.equal(await findFavicon(root), join(root, 'frontend', 'public', 'favicon.ico'));
});

test('syncFavicon: folgt keinen symbolischen Links (Datei oder Ordner)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'favicon-links-'));
  const outside = await mkdtemp(join(tmpdir(), 'favicon-outside-'));
  await writeFile(join(outside, 'id_ed25519'), 'GEHEIM');
  const updates: unknown[][] = [];
  const pool = {
    query: async (sql: string, params: unknown[]) => {
      if (sql.startsWith('SELECT')) return { rows: [{ mtime: new Date(1) }] };
      updates.push([sql, ...params]);
      return { rows: [] };
    },
  } as unknown as Pool;
  await symlink(join(outside, 'id_ed25519'), join(root, 'favicon.png'));
  assert.equal(await findFavicon(root), null, 'ein Link ist kein Favicon');
  await syncFavicon(pool, 'p', root);
  assert.equal(updates.length, 1);
  assert.match(String(updates[0]?.[0]), /favicon = NULL/);
  await writeFile(join(outside, 'favicon.ico'), 'GEHEIM');
  await symlink(outside, join(root, 'public'));
  updates.length = 0;
  await syncFavicon(pool, 'p', root);
  assert.ok(
    !updates.some((entry) => entry.some((value) => Buffer.isBuffer(value))),
    'nichts von ausserhalb gespeichert',
  );
  await rm(join(root, 'public'));
  await writeFile(join(root, 'favicon.svg'), '<svg/>');
  updates.length = 0;
  await syncFavicon(pool, 'p', root);
  assert.equal(String(updates[0]?.[2]), '<svg/>');
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});
