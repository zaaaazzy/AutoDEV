import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { findFavicon } from './favicon.js';

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
