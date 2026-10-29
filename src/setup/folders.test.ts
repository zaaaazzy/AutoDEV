import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { listFolders } from './folders.js';

function scope(): { root: string; env: NodeJS.ProcessEnv } {
  const root = mkdtempSync(join(tmpdir(), 'folders-'));
  mkdirSync(join(root, 'Beta', '.git'), { recursive: true });
  mkdirSync(join(root, 'alpha', 'src'), { recursive: true });
  mkdirSync(join(root, '.versteckt'));
  mkdirSync(join(root, 'node_modules'));
  return { root, env: { DEV_LOG_PROJECT_ROOTS: root } };
}

test('Übersicht zeigt die Projektbereiche', async () => {
  const { root, env } = scope();
  const listing = await listFolders('', env);
  assert.equal(listing.path, null);
  assert.deepEqual(
    listing.folders.map((folder) => folder.path),
    [root],
  );
});

test('Unterordner sortiert, ohne versteckte und Build-Ordner, Git markiert', async () => {
  const { root, env } = scope();
  const listing = await listFolders(root, env);
  assert.deepEqual(
    listing.folders.map((folder) => [folder.name, folder.git]),
    [
      ['alpha', false],
      ['Beta', true],
    ],
  );
  assert.equal(listing.parent, null);
  // Der Bereich selbst ist kein Projektordner, ein Unterordner schon.
  assert.equal(listing.selectable, false);
  const inner = await listFolders(join(root, 'alpha'), env);
  assert.equal(inner.selectable, true);
  assert.equal(inner.parent, root);
});

test('Ausserhalb des Projektbereichs und mit .. abgelehnt', async () => {
  const { root, env } = scope();
  await assert.rejects(listFolders('/etc', env), /ausserhalb/);
  await assert.rejects(listFolders(`${root}/alpha/../..`, env), /Ungültig/);
});

test('Windows-Pfade: Bereich ohne Gross-/Kleinschreibung, .. abgelehnt', async () => {
  const env = { DEV_LOG_PROJECT_ROOTS: 'C:\\Users\\me\\Projekte;D:\\Dev' };
  const listing = await listFolders('', env);
  assert.deepEqual(listing.roots, ['C:\\Users\\me\\Projekte', 'D:\\Dev']);
  await assert.rejects(listFolders('C:\\Users\\me\\Andere', env), /ausserhalb/);
  await assert.rejects(listFolders('C:\\Users\\me\\Projekte\\..\\..', env), /Ungültig/);
  // Im Bereich: Pfad wird angenommen und normalisiert (auf diesem Testrechner gibt es ihn nur nicht).
  await assert.rejects(listFolders('c:/users/me/projekte/app/', env), /nicht gefunden: c:\\users\\me\\projekte\\app$/i);
});
