import assert from 'node:assert/strict';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { containerPath, readFilePreview } from './files.js';

test('maps host repository paths into the read-only mount', () => {
  const env = { DEV_LOG_PROJECTS_HOST_ROOT: '/Volumes/External', DEV_LOG_PROJECTS_MOUNT: '/projects' };
  assert.equal(containerPath('/Volumes/External/Mainty', env), '/projects/Mainty');
  assert.equal(containerPath('/Users/x/repo', env), '/Users/x/repo');
  assert.equal(containerPath('/Volumes/External/Mainty', {}), '/Volumes/External/Mainty');
});

test('previews text files inside the repository only', async () => {
  const root = await mkdtemp(join(tmpdir(), 'devlog-files-'));
  const repo = join(root, 'repo');
  await mkdir(join(repo, 'src'), { recursive: true });
  await mkdir(join(repo, '.git'));
  await writeFile(join(repo, 'src', 'app.ts'), Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n'));
  await writeFile(join(repo, '.env'), 'SECRET=1');
  await writeFile(join(repo, '.git', 'config'), '[core]');
  await writeFile(join(repo, 'logo.png'), Buffer.from([137, 80, 0, 1]));
  await writeFile(join(root, 'outside.txt'), 'nope');
  await symlink(join(root, 'outside.txt'), join(repo, 'link.txt'));

  const preview = await readFilePreview(repo, 'src/app.ts');
  assert.equal(preview?.path, join('src', 'app.ts'));
  assert.equal(preview?.content.split('\n').length, 80);
  assert.equal(preview?.truncated, true);
  assert.equal((await readFilePreview(repo, join(repo, 'src', 'app.ts')))?.path, join('src', 'app.ts'));
  assert.equal((await readFilePreview(repo, 'logo.png'))?.binary, true);
  for (const blocked of ['.env', '.git/config', '../outside.txt', 'link.txt', 'src', 'missing.ts']) {
    assert.equal(await readFilePreview(repo, blocked), null, blocked);
  }
});
