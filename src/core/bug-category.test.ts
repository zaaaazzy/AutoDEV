import assert from 'node:assert/strict';
import test from 'node:test';
import { CATEGORIES } from './validation.js';
import {
  BUG_CATEGORIES,
  categoryFromBug,
  categoryFromPaths,
  isBugCategory,
  parseModelCategory,
  pathsInText,
} from './bug-category.js';

test('Wertesatz: genau die sechs Kategorien aus validation.ts', () => {
  assert.deepEqual([...BUG_CATEGORIES].sort(), [...CATEGORIES].sort());
  assert.equal(isBugCategory('backend'), true);
  assert.equal(isBugCategory('git'), false);
  assert.equal(isBugCategory('agent-guard'), false);
});

test('Pfade: src/ → backend, frontend/ → frontend, beides → fullstack', () => {
  assert.equal(categoryFromPaths(['src/core/test-bugs.test.ts']), 'backend');
  assert.equal(categoryFromPaths(['frontend/src/app/features/bugs/bug-stats.spec.ts']), 'frontend');
  assert.equal(categoryFromPaths(['frontend/src/app/app.ts', 'src/api/bugs.ts']), 'fullstack');
  // Absolute Pfade und Zeilenangaben aus Stacktraces.
  assert.equal(categoryFromPaths(['/srv/aideation/src/api/bugs.ts:141:7']), 'backend');
  assert.equal(categoryFromPaths(['C:\\dev\\aideation\\frontend\\src\\main.ts']), 'frontend');
});

test('Pfade: nur Wächter, Pfadregeln oder Rechte → security; zusammen mit anderem Backend → backend', () => {
  assert.equal(categoryFromPaths(['src/agent/agent-guard.ts']), 'security');
  assert.equal(categoryFromPaths(['src/agent/path-policy.ts', 'src/agent/permission-rules.ts']), 'security');
  assert.equal(categoryFromPaths(['src/agent/permissions.test.ts']), 'security');
  assert.equal(categoryFromPaths(['src/agent/agent-guard/shell.ts']), 'security');
  assert.equal(categoryFromPaths(['src/agent/agent-guard.ts', 'src/api/bugs.ts']), 'backend');
  assert.equal(categoryFromPaths(['src/agent/agent-guard.ts', 'frontend/src/app/app.ts']), 'fullstack');
});

test('security nur als ganzes Pfadsegment, nie als Teilstring', () => {
  assert.equal(categoryFromPaths(['src/agent/my-agent-guard.ts']), 'backend');
  assert.equal(categoryFromPaths(['src/agent/agent-guardian.ts']), 'backend');
  assert.equal(categoryFromPaths(['src/core/agent-guard.ts']), 'backend');
  assert.equal(categoryFromPaths(['frontend/src/agent/agent-guard.ts']), 'frontend');
  assert.equal(categoryFromPaths(['src/agentx/agent-guard.ts']), 'backend');
});

test('Pfade: deploy/ → infrastructure, docs/ → docs; Code mit Betrieb ist nicht eindeutig', () => {
  assert.equal(categoryFromPaths(['deploy/backup.sh']), 'infrastructure');
  assert.equal(categoryFromPaths(['deploy/caddy/Caddyfile', 'Dockerfile']), 'infrastructure');
  assert.equal(categoryFromPaths(['docs/erm.md']), 'docs');
  assert.equal(categoryFromPaths(['docs/erm.md', 'src/db/schema.ts']), 'backend');
  assert.equal(categoryFromPaths(['deploy/backup.sh', 'src/db/schema.ts']), null);
});

test('ohne eindeutigen Pfad: null (dann entscheidet das Modell)', () => {
  assert.equal(categoryFromPaths([]), null);
  assert.equal(categoryFromPaths(['node_modules/pg/lib/client.js']), null);
  assert.equal(categoryFromPaths(['../src/api/bugs.ts']), null);
  assert.equal(categoryFromPaths(['package.json', 'tmp/x.log']), null);
});

test('Pfade im Text: Testdateien und Stacktraces, kein Fliesstext wie „frontend/backend“', () => {
  assert.deepEqual(pathsInText('Testdatei: `src/core/test-bugs.test.ts`'), ['src/core/test-bugs.test.ts']);
  assert.deepEqual(pathsInText('at run (/app/src/api/bugs.ts:12:3)'), ['/app/src/api/bugs.ts:12:3']);
  assert.deepEqual(pathsInText('Das betrifft frontend/backend und src/ allgemein.'), []);
  assert.deepEqual(pathsInText('Siehe https://example.com/src/api/bugs.ts'), []);
});

test('Bug aus Titel, Beschreibung und ausdrücklichen Pfaden', () => {
  assert.equal(categoryFromBug({ title: 'Unit-Test: x', description: 'Testdatei: `src/core/a.test.ts`' }), 'backend');
  assert.equal(
    categoryFromBug({ title: 'Oberflächentest: y', description: 'fehlgeschlagen', paths: ['frontend/e2e/x.check.ts'] }),
    'frontend',
  );
  assert.equal(
    categoryFromBug({ title: 'z', description: 'Fehler in src/api/bugs.ts', paths: ['frontend/src/app/x.ts'] }),
    'fullstack',
  );
  assert.equal(categoryFromBug({ title: 'Speichern geht nicht', description: 'Nichts passiert.' }), null);
});

test('Modellantwort: nur einer der sechs Werte, sonst null', () => {
  assert.equal(parseModelCategory('{"category": "backend"}'), 'backend');
  assert.equal(parseModelCategory(' Frontend. '), 'frontend');
  assert.equal(parseModelCategory('"docs"'), 'docs');
  assert.equal(parseModelCategory('{"category": "git"}'), null);
  assert.equal(parseModelCategory('{"category": "other"}'), null);
  assert.equal(parseModelCategory('backend oder frontend'), null);
  assert.equal(parseModelCategory(''), null);
});
