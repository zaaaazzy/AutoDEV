import assert from 'node:assert/strict';
import { link, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import {
  createProjectDirectory,
  isInside,
  readProjectText,
  removeProjectDirectory,
  writeNewProjectFile,
} from './project-paths.js';

const base = await mkdtemp(join(tmpdir(), 'project-paths-'));
after(() => rm(base, { recursive: true, force: true }));

/** Neuer Projektordner plus ein Ordner „ausserhalb“ mit einem Geheimnis. */
async function setup(name: string): Promise<{ repo: string; outside: string }> {
  const repo = join(base, name, 'repo');
  const outside = join(base, name, 'outside');
  await mkdir(join(repo, 'docs'), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, 'id_rsa'), 'GEHEIM');
  return { repo, outside };
}

test('isInside: /repo-evil liegt nicht in /repo', () => {
  assert.equal(isInside('/repo', '/repo/docs/a.md'), true);
  assert.equal(isInside('/repo', '/repo'), true);
  assert.equal(isInside('/repo', '/repo-evil/a.md'), false);
  assert.equal(isInside('/repo', '/'), false);
});

test('readProjectText: normale Datei wird gelesen', async () => {
  const { repo } = await setup('normal');
  await writeFile(join(repo, 'docs', 'a.md'), '# A');
  assert.equal(await readProjectText(repo, 'docs/a.md', 1000), '# A');
});

test('readProjectText: Datei-Symlink nach aussen wird nicht gelesen', async () => {
  const { repo, outside } = await setup('file-link');
  await symlink(join(outside, 'id_rsa'), join(repo, 'docs', 'x.md'));
  assert.equal(await readProjectText(repo, 'docs/x.md', 1000), null);
});

test('readProjectText: Symlink innerhalb des Projekts wird ebenfalls abgelehnt', async () => {
  const { repo } = await setup('inner-link');
  await writeFile(join(repo, 'README.md'), 'ok');
  await symlink(join(repo, 'README.md'), join(repo, 'docs', 'readme.md'));
  assert.equal(await readProjectText(repo, 'docs/readme.md', 1000), null);
});

test('readProjectText: verlinkter Ordner (docs bzw. docs/sub) wird nicht gelesen', async () => {
  const { repo, outside } = await setup('dir-link');
  await writeFile(join(outside, 'a.md'), 'GEHEIM');
  await symlink(outside, join(repo, 'docs', 'sub'));
  assert.equal(await readProjectText(repo, 'docs/sub/a.md', 1000), null);
  await rm(join(repo, 'docs'), { recursive: true });
  await symlink(outside, join(repo, 'docs'));
  assert.equal(await readProjectText(repo, 'docs/a.md', 1000), null);
});

test('readProjectText: Link ins Leere, fehlende Datei, Hardlink, zu gross und .. werden übersprungen', async () => {
  const { repo, outside } = await setup('misc');
  await symlink(join(outside, 'gibt-es-nicht'), join(repo, 'docs', 'leer.md'));
  assert.equal(await readProjectText(repo, 'docs/leer.md', 1000), null);
  assert.equal(await readProjectText(repo, 'docs/fehlt.md', 1000), null);
  await link(join(outside, 'id_rsa'), join(repo, 'docs', 'hard.md'));
  assert.equal(await readProjectText(repo, 'docs/hard.md', 1000), null);
  await writeFile(join(repo, 'docs', 'gross.md'), 'x'.repeat(20));
  assert.equal(await readProjectText(repo, 'docs/gross.md', 10), null);
  assert.equal(await readProjectText(join(repo, 'docs'), '../../outside/id_rsa', 1000), null);
  assert.equal(await readProjectText(repo, join(outside, 'id_rsa'), 1000), null);
});

test('removeProjectDirectory: verlinkter .dev-log wird nicht durchlaufen, das Ziel bleibt', async () => {
  const { repo, outside } = await setup('remove-link');
  await mkdir(join(outside, 'attachments', 'item'), { recursive: true });
  await writeFile(join(outside, 'attachments', 'item', 'wichtig.txt'), 'bleibt');
  await symlink(outside, join(repo, '.dev-log'));
  assert.equal(await removeProjectDirectory(repo, '.dev-log/attachments/item'), false);
  assert.equal(await readFile(join(outside, 'attachments', 'item', 'wichtig.txt'), 'utf8'), 'bleibt');
  assert.equal(await createProjectDirectory(repo, '.dev-log/attachments/item'), null);
});

test('removeProjectDirectory: verlinkter Zielordner – nur der Link verschwindet', async () => {
  const { repo, outside } = await setup('remove-target-link');
  await mkdir(join(repo, '.dev-log', 'attachments'), { recursive: true });
  await symlink(outside, join(repo, '.dev-log', 'attachments', 'item'));
  assert.equal(await removeProjectDirectory(repo, '.dev-log/attachments/item'), true);
  assert.deepEqual(await readdir(outside), ['id_rsa']);
  assert.deepEqual(await readdir(join(repo, '.dev-log', 'attachments')), []);
});

test('createProjectDirectory und writeNewProjectFile: schreiben nur neue Dateien, keinen Link', async () => {
  const { repo, outside } = await setup('write');
  assert.equal(await removeProjectDirectory(repo, '.dev-log/attachments/item'), true);
  const directory = await createProjectDirectory(repo, '.dev-log/attachments/item');
  assert.ok(directory);
  assert.equal(await writeNewProjectFile(directory, '1-bild.png', Buffer.from('png')), true);
  assert.equal(await readFile(join(directory, '1-bild.png'), 'utf8'), 'png');
  await symlink(join(outside, 'id_rsa'), join(directory, '2-bild.png'));
  assert.equal(await writeNewProjectFile(directory, '2-bild.png', Buffer.from('x')), false);
  assert.equal(await writeNewProjectFile(directory, '../x.png', Buffer.from('x')), false);
  assert.equal(await readFile(join(outside, 'id_rsa'), 'utf8'), 'GEHEIM');
});
