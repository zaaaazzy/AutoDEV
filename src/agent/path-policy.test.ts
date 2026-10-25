import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileProblem, type GuardPolicy } from './agent-guard.js';
import { resolveInside, ToolError } from './tool-paths.js';

/**
 * Gemeinsame Tabelle für beide Wächter: Claude-Wächter (fileProblem) und Datei-Werkzeuge des lokalen Modells
 * (resolveInside) müssen bei denselben Pfaden dasselbe entscheiden.
 */
const root = realpathSync(mkdtempSync(join(tmpdir(), 'path-policy-')));
const outside = realpathSync(mkdtempSync(join(tmpdir(), 'path-policy-outside-')));
for (const dir of ['src', 'docs', 'vendor', 'frontend', 'node_modules/paket', '.dev-log-backups', '.vscode', '.git/hooks']) {
  mkdirSync(join(root, dir), { recursive: true });
}
writeFileSync(join(root, 'node_modules/paket/index.js'), 'module.exports = 1;');
writeFileSync(join(root, '.dev-log-backups/alt.patch'), '');
writeFileSync(join(root, '.vscode/settings.json'), '{}');
writeFileSync(join(root, '.yarnrc.yml'), '');
writeFileSync(join(root, 'vendor/x.js'), '');
// Links: auf gesperrte Ziele, ein gesperrter Name als Link auf einen harmlosen Ordner, ein Ausbruch.
symlinkSync('node_modules', join(root, 'deps'));
symlinkSync('.vscode', join(root, 'editor'));
symlinkSync('.dev-log-backups', join(root, 'sicherung'));
symlinkSync('.yarnrc.yml', join(root, 'yarn.txt'));
symlinkSync('../vendor', join(root, 'frontend/node_modules'));
symlinkSync(outside, join(root, 'raus'));

after(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

const PROTECTED = [
  // Abhängigkeiten: per .gitignore unsichtbar, laufen aber bei jedem Test mit.
  'node_modules/paket/index.js',
  'node_modules/neu/index.js',
  'Node_Modules/paket/index.js',
  'frontend/node_modules/x.js',
  'src/../node_modules/paket/index.js',
  'deps/paket/index.js',
  // Sicherungen liessen sich fälschen.
  '.dev-log-backups/alt.patch',
  '.DEV-LOG-BACKUPS/neu.patch',
  'sicherung/neu.patch',
  // Paketmanager-Einstellungen: script-shell, node-options, Registry am Wächter vorbei.
  '.npmrc',
  'frontend/.npmrc',
  '.NPMRC',
  '.yarnrc',
  '.yarnrc.yml',
  'frontend/.Yarnrc.yml',
  'yarn.txt',
  '.pnpmrc',
  // Hooks und Editor-Aufgaben (tasks.json startet Befehle beim Öffnen des Ordners).
  '.git/config',
  '.git/hooks/pre-commit',
  '.husky/pre-commit',
  '.githooks/pre-push',
  '.vscode/settings.json',
  '.vscode/tasks.json',
  '.VSCode/tasks.json',
  'editor/tasks.json',
  // Agent-Einstellungen und Geheimnisse.
  '.claude/settings.json',
  '.mcp.json',
  '.env',
  'src/.env.local',
  'server.key',
  'certs/tls.pem',
  '.ssh/config',
];

const ALLOWED = [
  'src/app.ts',
  'src/node_modules_info.ts',
  'docs/node_modules.md',
  'docs/dev-log-backups.md',
  'src/backups/alt.ts',
  'docs/npmrc.md',
  'docs/yarnrc.md',
  'src/vscode.ts',
  'docs/husky.md',
  'src/githooks.ts',
  'vendor/neu.js',
];

const all: GuardPolicy = { create: true, edit: true, scopes: [] };
const claude = (path: string) => fileProblem({ tool_name: 'Write', tool_input: { file_path: path }, cwd: root }, all, root);
const ollama = (path: string) =>
  resolveInside(root, path, true).then(
    () => null,
    (error: unknown) => (error instanceof ToolError ? error.message : String(error)),
  );

test('Pfad-Richtlinie: beide Wächter sperren dieselben Pfade', async () => {
  for (const path of PROTECTED) {
    assert.match(claude(path) ?? '', /geschützt/, `Claude: ${path}`);
    assert.match((await ollama(path)) ?? '', /nicht erlaubt/, `Ollama: ${path}`);
  }
});

test('Pfad-Richtlinie: ähnliche Namen bleiben für beide Wächter beschreibbar', async () => {
  for (const path of ALLOWED) {
    assert.equal(claude(path), null, `Claude: ${path}`);
    assert.equal(await ollama(path), null, `Ollama: ${path}`);
  }
});

test('Pfad-Richtlinie: absolute Pfade und Pfade ausserhalb entscheiden beide Wächter gleich', async () => {
  assert.match(claude(join(root, 'node_modules/paket/index.js')) ?? '', /geschützt/);
  assert.match((await ollama(join(root, 'node_modules/paket/index.js'))) ?? '', /nicht erlaubt/);
  assert.equal(claude(join(root, 'src/app.ts')), null);
  assert.equal(await ollama(join(root, 'src/app.ts')), null);
  for (const path of ['../x.ts', 'raus/x.ts', '/etc/hosts']) {
    assert.match(claude(path) ?? '', /ausserhalb/, `Claude: ${path}`);
    assert.match((await ollama(path)) ?? '', /außerhalb/, `Ollama: ${path}`);
  }
});
