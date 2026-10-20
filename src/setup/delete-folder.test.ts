import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { deleteProjectFolder } from './setup-jobs.js';

// Unabhängig vom Projektbereich der Umgebung (der Worker setzt ihn, z. B. im Test-Gate).
delete process.env.DEV_LOG_PROJECT_ROOTS;

test('deletes a project folder but refuses shallow paths, symlinks and AIdeation itself', async () => {
  const base = await mkdtemp(join(tmpdir(), 'devlog-delete-'));
  const project = join(base, 'projekt');
  await mkdir(join(project, 'src'), { recursive: true });
  await writeFile(join(project, 'src', 'a.ts'), 'x');
  const link = join(base, 'verknuepfung');
  await symlink(project, link);

  await assert.rejects(deleteProjectFolder({ path: link }), /kein normaler Ordner/);
  await assert.rejects(deleteProjectFolder({ path: '/Users' }), /Projektordner|zu weit oben/);
  await assert.rejects(
    deleteProjectFolder({ path: join(import.meta.dirname, '..', '..') }),
    /AIdeation-Ordner|Projektordner/,
  );
  assert.deepEqual(await deleteProjectFolder({ path: project }), { deleted: true, path: project });
  assert.equal(existsSync(project), false);
});
