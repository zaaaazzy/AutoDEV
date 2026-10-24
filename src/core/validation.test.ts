import assert from 'node:assert/strict';
import test from 'node:test';
import { invalidInput, parseOption, parseTitle, projectFolderError, projectRoots } from './validation.js';

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

test('Windows-Projektordner mit Laufwerksbuchstaben', () => {
  for (const ok of [
    'C:\\Users\\name\\Projekte\\app',
    'c:\\Users\\name\\Projekte\\app\\',
    'C:/Users/name/Projekte/app',
    'D:\\Projekte\\app',
    'E:\\Dev',
  ])
    assert.equal(projectFolderError(ok, {}), null, ok);
  const blocked = /zu breit oder Systemordner/;
  for (const tooBroad of ['C:\\', 'C:/', 'D:\\', 'C:\\Users', 'c:\\users\\', 'C:\\Users\\name', 'C:\\Users\\Public'])
    assert.match(projectFolderError(tooBroad, {}) ?? '', blocked, tooBroad);
  for (const system of [
    'C:\\Windows',
    'C:\\WINDOWS\\System32\\app',
    'C:\\Program Files\\app',
    'C:\\Program Files (x86)\\app',
    'C:\\ProgramData\\app',
    'C:\\Users\\name\\AppData\\Roaming\\app',
    'C:\\$Recycle.Bin\\x',
  ])
    assert.match(projectFolderError(system, {}) ?? '', blocked, system);
  for (const bad of [
    'C:\\Users\\name\\..\\other\\app',
    'C:\\Users\\name\\Projekte\\..',
    'C:\\Users\\name\\.\\app',
    'C:\\Users\\name\\...\\app',
    'C:\\Users\\name\\\\app',
    'C:\\Users\\name\\app:stream',
    'C:\\Users\\name\\a?b',
    'C:relative\\app',
    '\\\\server\\share\\app',
    'Projekte\\app',
  ])
    assert.ok(projectFolderError(bad, {}), bad);
  assert.match(projectFolderError('C:\\Users\\name\\..\\x\\y', {}) ?? '', /"\.\."/);
});

test('DEV_LOG_PROJECT_ROOTS: Windows-Bereiche mit ";" oder ":" getrennt, macOS/Linux unverändert', () => {
  assert.deepEqual(projectRoots({ DEV_LOG_PROJECT_ROOTS: '/Users/me/Projekte:/Volumes/External/' }), [
    '/Users/me/Projekte',
    '/Volumes/External',
  ]);
  assert.deepEqual(projectRoots({ DEV_LOG_PROJECT_ROOTS: 'C:\\Users\\me\\Projekte;d:/Dev/' }), [
    'C:\\Users\\me\\Projekte',
    'D:\\Dev',
  ]);
  assert.deepEqual(projectRoots({ DEV_LOG_PROJECT_ROOTS: 'C:\\Users\\me\\Projekte:D:\\Dev' }), [
    'C:\\Users\\me\\Projekte',
    'D:\\Dev',
  ]);
  assert.deepEqual(projectRoots({ DEV_LOG_PROJECT_ROOTS: ' C:\\ ; relative ' }), ['C:\\']);

  const env = { DEV_LOG_PROJECT_ROOTS: 'C:\\Users\\me\\Projekte;D:\\Dev' };
  assert.equal(projectFolderError('C:\\Users\\me\\Projekte\\app', env), null);
  assert.equal(projectFolderError('c:\\users\\ME\\projekte\\app', env), null);
  assert.equal(projectFolderError('D:/Dev/app', env), null);
  assert.match(projectFolderError('C:\\Users\\me\\Andere\\app', env) ?? '', /unterhalb von/);
  assert.match(projectFolderError('C:\\Users\\me\\ProjekteX\\app', env) ?? '', /unterhalb von/);
  // Der Bereich selbst ist kein Projektordner, nur seine Unterordner.
  assert.match(projectFolderError('C:\\Users\\me\\Projekte', env) ?? '', /unterhalb von/);
  // Unix-Pfade liegen nie in einem Windows-Bereich und umgekehrt.
  assert.ok(projectFolderError('/Users/me/Projekte/app', env));
  assert.ok(projectFolderError('C:\\Users\\me\\Projekte\\app', { DEV_LOG_PROJECT_ROOTS: '/Users/me/Projekte' }));
  // Ein ganzes Laufwerk als Bereich: Unterordner erlaubt, das Laufwerk selbst nicht.
  assert.equal(projectFolderError('E:\\app', { DEV_LOG_PROJECT_ROOTS: 'E:\\' }), null);
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
