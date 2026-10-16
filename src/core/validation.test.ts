import assert from 'node:assert/strict';
import test from 'node:test';
import { projectFolderError } from './validation.js';

test('project folders must be specific absolute paths', () => {
  for (const ok of ['/Volumes/External/Mainty', '/Users/me/projekte/app', '/srv/app']) assert.equal(projectFolderError(ok, {}), null, ok);
  for (const bad of ['relative/dir', '/', '/Users', '/Users/me', '/Volumes/External', '/etc/nginx', '/Users/me/../you/x', '/a//b', '']) {
    assert.ok(projectFolderError(bad, {}), bad);
  }
  assert.equal(projectFolderError('/Volumes/External/Mainty', { DEV_LOG_PROJECT_ROOTS: '/Volumes/External' }), null);
  assert.ok(projectFolderError('/Users/me/x/y', { DEV_LOG_PROJECT_ROOTS: '/Volumes/External' }));
});
