import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runCommand } from '../../core/command.js';
import {
  diffTargetPath,
  filesWithSecrets,
  gitHelpers,
  isPlaceholderToken,
  setAsideFiles,
  stageAll,
} from './git-helpers.js';
import { enterOrderBranch, finishOrderBranch } from './order-branch.js';

test('diffTargetPath liest Tab-Suffix und C-Escapes', () => {
  assert.equal(diffTargetPath('+++ b/plain.txt'), 'plain.txt');
  assert.equal(diffTargetPath('+++ b/my notes.txt\t'), 'my notes.txt');
  assert.equal(diffTargetPath('+++ "b/zug\\303\\244nge.txt"'), 'zugänge.txt');
  assert.equal(diffTargetPath('+++ "b/quote\\"d.txt"'), 'quote"d.txt');
  assert.equal(diffTargetPath('+++ /dev/null'), null);
});

// Vorher blieben Dateien mit Leerzeichen oder Umlaut im Namen trotz Zugangsdaten gestagt und wären gepusht worden.
test('stageAll hält Zugangsdaten auch in Dateien mit Leerzeichen, Umlauten und Sonderzeichen zurück', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'secret-holdback-'));
  const run = (...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();
  run('init', '-q', '-b', 'main');
  const key = 'AKIA' + 'ABCDEFGHIJKLMNOP';
  await writeFile(join(cwd, 'my notes.txt'), `aws ${key}\n`);
  await writeFile(join(cwd, 'zugänge.txt'), `aws ${key}\n`);
  await writeFile(join(cwd, 'stern*[1].txt'), `aws ${key}\n`);
  await writeFile(join(cwd, 'harmlos.txt'), 'hallo\n');
  const { git, must } = gitHelpers(runCommand, cwd);
  const held = await stageAll(git, must, []);
  assert.deepEqual(held.sort(), ['my notes.txt', 'stern*[1].txt', 'zugänge.txt']);
  assert.equal(run('-c', 'core.quotePath=false', 'diff', '--cached', '--name-only'), 'harmlos.txt');
});

// Testwerte zusammengesetzt, sonst hielte der Commit-Schutz diese Datei selbst zurück.
const ANTHROPIC_PLACEHOLDER = 'sk-ant-' + 'api03-AbCdEfGhIjKlMnOpQrStUvWx';
const GITHUB_PLACEHOLDER = 'ghp_' + 'x'.repeat(36);
const PEM_PLACEHOLDER = '-----BEGIN ' + 'PRIVATE KEY-----\\nMIIEvQ\\n-----END ' + 'PRIVATE KEY-----';
const REAL_LOOKING_ANTHROPIC = 'sk-ant-' + 'api03-q7Zp2LmX9vRt4KwN8sYb3HcJ6dFg';
const REAL_LOOKING_GITHUB = 'ghp_' + 'Q7zP2lMx9VrT4kWn8SyB3hCj6DfG1aE5uR0o';

function diffOf(file: string, ...lines: string[]): string {
  return [`+++ b/${file}`, '@@ -0,0 +1 @@', ...lines.map((line) => `+${line}`)].join('\n');
}

test('isPlaceholderToken erkennt bekannte Platzhalter, nicht aber zufällige Schlüssel', () => {
  assert.ok(isPlaceholderToken(ANTHROPIC_PLACEHOLDER));
  assert.ok(isPlaceholderToken(GITHUB_PLACEHOLDER));
  assert.ok(isPlaceholderToken('AKIA' + 'IOSFODNN7EXAMPLE'));
  assert.ok(!isPlaceholderToken(REAL_LOOKING_ANTHROPIC));
  assert.ok(!isPlaceholderToken(REAL_LOOKING_GITHUB));
});

test('filesWithSecrets: Platzhalter in *.test.ts/*.spec.ts zählen nicht, in anderen Dateien schon', () => {
  const line = `const key = '${ANTHROPIC_PLACEHOLDER}'; const gh = '${GITHUB_PLACEHOLDER}';`;
  assert.deepEqual(filesWithSecrets(diffOf('src/agent/tool-sql.test.ts', line)), []);
  assert.deepEqual(filesWithSecrets(diffOf('e2e/login.spec.ts', `const pem = '${PEM_PLACEHOLDER}';`)), []);
  assert.deepEqual(filesWithSecrets(diffOf('src/agent/tool-sql.ts', line)), ['src/agent/tool-sql.ts']);
});

test('filesWithSecrets: echte Schlüssel in Testdateien bleiben zurückgehalten – je Fundstelle geprüft', () => {
  assert.deepEqual(filesWithSecrets(diffOf('a.test.ts', `'${REAL_LOOKING_GITHUB}'`)), ['a.test.ts']);
  // Ein Platzhalter daneben macht den echten Schlüssel in derselben Zeile nicht harmlos.
  assert.deepEqual(filesWithSecrets(diffOf('b.test.ts', `'${GITHUB_PLACEHOLDER}', '${REAL_LOOKING_ANTHROPIC}'`)), [
    'b.test.ts',
  ]);
  // Ein echter PEM-Block über mehrere Zeilen ist kein Testwert.
  assert.deepEqual(filesWithSecrets(diffOf('c.spec.ts', 'const pem = `-----BEGIN ' + 'PRIVATE KEY-----')), [
    'c.spec.ts',
  ]);
});

test('filesWithSecrets: markierte Testwerte (gleiche oder vorige Zeile) zählen nur in Testdateien nicht', () => {
  const marked = `'${REAL_LOOKING_GITHUB}' // dev-log: testwert`;
  assert.deepEqual(filesWithSecrets(diffOf('a.test.ts', marked)), []);
  assert.deepEqual(
    filesWithSecrets(diffOf('a.test.ts', '// dev-log: testwert', 'const pem = `-----BEGIN ' + 'PRIVATE KEY-----')),
    [],
  );
  assert.deepEqual(filesWithSecrets(diffOf('config.ts', marked)), ['config.ts']);
});

test('stageAll committet Testdateien mit Platzhaltern, hält echte Schlüssel weiter zurück', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'secret-holdback-'));
  const run = (...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();
  run('init', '-q', '-b', 'main');
  await writeFile(join(cwd, 'redact.test.ts'), `const key = '${ANTHROPIC_PLACEHOLDER}';\n`);
  await writeFile(join(cwd, 'leak.test.ts'), `const key = '${REAL_LOOKING_ANTHROPIC}';\n`);
  const { git, must } = gitHelpers(runCommand, cwd);
  assert.deepEqual(await stageAll(git, must, []), ['leak.test.ts']);
  assert.equal(run('diff', '--cached', '--name-only'), 'redact.test.ts');
});

// Vorher: Auftrag galt als erledigt ohne die zurückgehaltenen Tests; die Dateien wanderten in den Sprint-Branch mit und
// der nächste Auftrag pausierte den Sprint („fremde, nicht committete Änderungen“).
test('finishOrderBranch: zurückgehaltene Dateien verhindern den Merge, blockieren aber nicht den nächsten Auftrag', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'secret-holdback-'));
  const run = (...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();
  run('init', '-q', '-b', 'main');
  run('config', 'user.email', 'mensch@example.com');
  run('config', 'user.name', 'Mensch');
  await writeFile(join(cwd, 'base.txt'), 'base\n');
  run('add', '-A');
  run('commit', '-q', '-m', 'base');
  const item = { id: '87704371-0000', title: 'Redaction' };
  const branch = await enterOrderBranch(cwd, item, 'Sprint 1');
  assert.ok(branch);
  await writeFile(join(cwd, 'redact.ts'), 'export {};\n');
  await writeFile(join(cwd, 'redact.test.ts'), `const key = '${REAL_LOOKING_ANTHROPIC}';\n`);
  const result = await finishOrderBranch(cwd, item, branch, 'Sprint 1', true);
  assert.equal(result.merged, false);
  assert.deepEqual(result.secrets, ['redact.test.ts']);
  assert.match(result.message, /Zugangsdaten aussehen: redact\.test\.ts/);
  assert.doesNotMatch(result.message, /Merge-Konflikt/);
  // Nichts in den Sprint gemergt, der Rest liegt auf dem Auftrags-Branch, die Datei gesichert statt im Ordner.
  assert.equal(run('rev-parse', '--abbrev-ref', 'HEAD'), 'sprint/sprint-1');
  assert.equal(run('rev-list', '--count', 'sprint/sprint-1'), '1');
  assert.match(run('show', '--name-only', '--format=', branch.branch), /redact\.ts/);
  assert.ok(!existsSync(join(cwd, 'redact.test.ts')));
  const folder = /gesichert in (\S+)\.\s/.exec(result.message)?.[1];
  assert.ok(folder && existsSync(join(cwd, folder, 'redact.test.ts')));
  assert.equal(run('status', '--porcelain'), '');
  assert.ok(await enterOrderBranch(cwd, { id: '5e6f7a8b-0000', title: 'Profil' }, 'Sprint 1'));
});

// Vorher kopierte setAsideFiles mit copyFile, das Links folgt: Host-Dateien landeten in der Sicherung im Projekt.
test('setAsideFiles sichert einen zurückgehaltenen Symlink nicht mit dem Inhalt seines Ziels', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'secret-symlink-'));
  const outside = await mkdtemp(join(tmpdir(), 'secret-host-'));
  await writeFile(join(outside, 'id_ed25519'), 'HOST-SCHLUESSEL\n');
  const run = (...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();
  run('init', '-q', '-b', 'main');
  run('-c', 'user.name=T', '-c', 'user.email=t@x', 'commit', '-q', '--allow-empty', '-m', 'Start');
  // Zugangsdaten-Muster im Linkziel: git diff zeigt bei Symlinks das Ziel als Inhalt, stageAll hält ihn zurück.
  const key = 'AKIA' + 'QWERTYUIOPLKJHGF';
  await mkdir(join(cwd, key));
  await symlink(`${key}/../${'../'.repeat(12)}${outside.slice(1)}/id_ed25519`, join(cwd, 'leak'));
  await writeFile(join(cwd, 'normal.txt'), `aws ${key}\n`);
  assert.equal(
    await readFile(join(cwd, 'leak'), 'utf8'),
    'HOST-SCHLUESSEL\n',
    'Gegenprobe: der Link erreicht die Host-Datei',
  );
  const { git, must } = gitHelpers(runCommand, cwd);
  const held = await stageAll(git, must, []);
  assert.deepEqual(held.sort(), ['leak', 'normal.txt']);
  const folder = await setAsideFiles(git, cwd, held, 'zurueckgehalten-test');
  const saved = await readdir(join(cwd, folder));
  assert.deepEqual(saved, ['normal.txt']);
  assert.equal(await readFile(join(cwd, folder, 'normal.txt'), 'utf8'), `aws ${key}\n`);
  assert.equal(
    lstatSync(join(cwd, 'leak'), { throwIfNoEntry: false }),
    undefined,
    'Der Link bleibt nicht im Arbeitsordner',
  );
  assert.equal(await readFile(join(outside, 'id_ed25519'), 'utf8'), 'HOST-SCHLUESSEL\n');
});
