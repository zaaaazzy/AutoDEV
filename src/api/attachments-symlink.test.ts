import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { Pool } from 'pg';
import { materializeAttachments } from './attachments.js';

const base = await mkdtemp(join(tmpdir(), 'attachments-'));
after(() => rm(base, { recursive: true, force: true }));

const ITEM = '7b1f3c2e-1d4a-4c8e-9f00-123456789abc';
const IDEA = '0c7e5d1a-2b3c-4d5e-8f90-abcdefabcdef';
const pool = {
  query: async () => ({ rows: [{ id: 'a', filename: 'bild.png', data: Buffer.from('png') }] }),
} as unknown as Pool;

test('Anhänge: normaler Ordner wird geleert und neu befüllt', async () => {
  const repo = join(base, 'normal');
  await mkdir(join(repo, '.dev-log', 'attachments', ITEM), { recursive: true });
  await writeFile(join(repo, '.dev-log', 'attachments', ITEM, 'alt.png'), 'alt');
  const paths = await materializeAttachments(pool, { ideationId: IDEA }, ITEM, repo);
  assert.deepEqual(paths, [join('.dev-log', 'attachments', ITEM, '1-bild.png')]);
  assert.deepEqual(await readdir(join(repo, '.dev-log', 'attachments', ITEM)), ['1-bild.png']);
});

test('Anhänge: verlinkter .dev-log – Ziel bleibt unverändert, nichts gelöscht oder geschrieben', async () => {
  const repo = join(base, 'linked');
  const outside = join(base, 'outside');
  await mkdir(repo, { recursive: true });
  await mkdir(join(outside, 'attachments', ITEM), { recursive: true });
  await writeFile(join(outside, 'attachments', ITEM, 'wichtig.txt'), 'bleibt');
  await symlink(outside, join(repo, '.dev-log'));
  assert.deepEqual(await materializeAttachments(pool, { ideationId: IDEA }, ITEM, repo), []);
  assert.deepEqual(await materializeAttachments(pool, {}, ITEM, repo), []);
  assert.deepEqual(await readdir(join(outside, 'attachments', ITEM)), ['wichtig.txt']);
  assert.equal(await readFile(join(outside, 'attachments', ITEM, 'wichtig.txt'), 'utf8'), 'bleibt');
});
