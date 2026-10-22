import assert from 'node:assert/strict';
import test from 'node:test';
import { invalidInput, parseOption, parseTitle, projectFolderError } from './validation.js';

test('project folders must be specific absolute paths', () => {
  for (const ok of ['/Volumes/External/Mainty', '/Users/me/projekte/app', '/srv/app'])
    assert.equal(projectFolderError(ok, {}), null, ok);
  for (const bad of [
    'relative/dir',
    '/',
    '/Users',
    '/Users/me',
    '/Volumes/External',
    '/etc/nginx',
    '/Users/me/../you/x',
    '/a//b',
    '',
  ]) {
    assert.ok(projectFolderError(bad, {}), bad);
  }
  assert.equal(projectFolderError('/Volumes/External/Mainty', { DEV_LOG_PROJECT_ROOTS: '/Volumes/External' }), null);
  assert.ok(projectFolderError('/Users/me/x/y', { DEV_LOG_PROJECT_ROOTS: '/Volumes/External' }));
  // Der Bereich selbst ist kein Projektordner, nur seine Unterordner.
  assert.ok(projectFolderError('/Users/me/Projekte', { DEV_LOG_PROJECT_ROOTS: '/Users/me/Projekte' }));
  assert.equal(projectFolderError('/Users/me/Projekte/a', { DEV_LOG_PROJECT_ROOTS: '/Users/me/Projekte/' }), null);
});

const SPEC = {
  title: { column: 'title', parse: parseTitle(80) },
  priority: { column: 'priority', parse: parseOption(new Set(['low', 'medium', 'high'])) },
};

test('invalidInput: leeres Pflichtfeld wird mit deutschem Feldnamen gemeldet', () => {
  assert.deepEqual(invalidInput({ title: '   ' }, SPEC, ['title']), {
    field: 'title',
    message: 'Bitte Titel angeben.',
  });
  assert.deepEqual(invalidInput({}, SPEC, ['title']), { field: 'title', message: 'Bitte Titel angeben.' });
});

test('invalidInput: ungültiger Wert nennt das Feld', () => {
  assert.deepEqual(invalidInput({ title: 'Neu', priority: 'urgent' }, SPEC, ['title']), {
    field: 'priority',
    message: 'Priorität: ungültiger Wert.',
  });
});

test('invalidInput: ohne Daten oder ohne erkennbares Feld bleibt die Meldung allgemein, aber deutsch', () => {
  assert.deepEqual(invalidInput(null, SPEC), { message: 'Die Anfrage enthält keine Angaben.' });
  assert.deepEqual(invalidInput({ unbekannt: 1 }, SPEC), { message: 'Keine gültigen Angaben zum Speichern.' });
});
