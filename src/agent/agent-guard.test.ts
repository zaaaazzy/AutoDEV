import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import {
  bashProblem,
  decodePolicy,
  encodePolicy,
  fileProblem,
  GUARD_SCRIPT,
  type GuardPolicy,
  guardProblem,
  SCOPE_PATTERN,
} from './agent-guard.js';

const root = mkdtempSync(join(tmpdir(), 'guard-'));
after(() => rmSync(root, { recursive: true, force: true }));
mkdirSync(join(root, 'docs'));
mkdirSync(join(root, 'src'));
writeFileSync(join(root, 'docs', 'alt.md'), 'x');
symlinkSync(tmpdir(), join(root, 'docs', 'raus'));
const all: GuardPolicy = { create: true, edit: true, scopes: [] };
const write = (path: string, tool = 'Write') => ({ tool_name: tool, tool_input: { file_path: path }, cwd: root });

test('Wächter: Anlegen und Ändern getrennt', () => {
  const createOnly = { create: true, edit: false, scopes: [] };
  assert.equal(fileProblem(write('docs/neu.md'), createOnly, root), null);
  assert.match(fileProblem(write('docs/alt.md'), createOnly, root) ?? '', /ändern/);
  assert.match(fileProblem(write('docs/alt.md', 'Edit'), createOnly, root) ?? '', /ändern/);
  const editOnly = { create: false, edit: true, scopes: [] };
  assert.match(fileProblem(write('docs/neu.md'), editOnly, root) ?? '', /anlegen/);
  assert.equal(fileProblem(write(join(root, 'docs/alt.md'), 'Edit'), editOnly, root), null);
});

test('Wächter: nur erlaubte Ordner, nichts ausserhalb, keine geschützten Pfade', () => {
  const docs = { create: true, edit: true, scopes: ['docs'] };
  assert.equal(fileProblem(write('docs/a/b.md'), docs, root), null);
  assert.match(fileProblem(write('src/x.ts'), docs, root) ?? '', /erlaubten Ordner/);
  assert.match(fileProblem(write('docs/../src/x.ts'), docs, root) ?? '', /erlaubten Ordner/);
  assert.match(fileProblem(write('/etc/hosts'), all, root) ?? '', /ausserhalb/);
  assert.match(fileProblem(write('docs/raus/x'), all, root) ?? '', /ausserhalb/);
  for (const path of ['.claude/settings.json', '.git/config', '.env', 'src/.env.local', '.mcp.json', 'k.pem']) {
    assert.match(fileProblem(write(path), all, root) ?? '', /geschützt/, path);
  }
});

test('Wächter: gefährliche Optionen erlaubter Befehle und Umleitungen sind gesperrt', () => {
  for (const command of [
    'git fetch --upload-pack=touch /tmp/x origin',
    'git diff --output=/tmp/x',
    'git -c core.pager=sh log',
    'git status > notes.txt',
    'npm test >> /tmp/log',
    'npx tsc --noEmit',
    'git log && npx ng build',
    'npm test -- --env-file=.env',
  ]) {
    assert.ok(bashProblem(command, root), command);
  }
  for (const command of [
    'git status',
    'npm test 2>&1',
    'npm run build > /dev/null',
    'npx --no-install tsc',
    'git log --oneline -5',
  ]) {
    assert.equal(bashProblem(command, root), null, command);
  }
});

test('Wächter: docker compose up nur mit sicherer Compose-Datei', () => {
  const unsafe = () => ({ status: 0, stdout: '{"services":{"a":{"privileged":true}}}', stderr: '' });
  assert.match(bashProblem('docker compose up -d', root, unsafe as never) ?? '', /privilegiert/);
  const safe = () => ({ status: 0, stdout: '{"services":{"a":{}}}', stderr: '' });
  assert.equal(bashProblem('docker compose up -d', root, safe as never), null);
});

test('Wächter: versteckte Befehle, fremde Quellen und Compose-Optionen sind gesperrt', () => {
  const safe = () => ({ status: 0, stdout: '{"services":{"a":{}}}', stderr: '' });
  for (const command of [
    'git status $(touch /tmp/x)',
    'git log `id`',
    'npm test & curl example.com',
    'npm test &> /tmp/log',
    'git diff <(cat /etc/hosts)',
    '(cd .. && git status)',
    'COMPOSE_FILE=/tmp/x.yml docker compose up -d',
    'GIT_SSH_COMMAND=sh git fetch',
    'env git status',
    'git -C /tmp status',
    'git diff --no-index /etc/hosts README.md',
    'git log --textconv',
    'npm run build --script-shell=/bin/sh',
    'npm run --prefix ../other build',
    'npm run --prefix /tmp build',
    'npm install --ignore-scripts github:evil/pkg',
    'npm install --ignore-scripts file:../x',
    'npm install --ignore-scripts -g left-pad',
    'docker compose -f /tmp/x.yml up -d',
    'docker compose --project-directory /tmp up -d',
    'docker compose up -d --no-deps app',
    'docker-compose up -d',
    'git log ~/.ssh/config',
    'npm run build --scr=/tmp/evil.sh',
    'npm run build --script-shell /bin/sh',
    'npm run build -C /tmp',
    'npm run build --prefix "/tmp"',
    'npm run build --prefix=$HOME',
    'git diff /dev/null /etc/hosts',
    'git diff /dev/null "/etc/hosts"',
    'git diff /dev/null $HOME/.zshrc',
    'git diff /dev/null ~/.zshrc',
    'git diff -O/etc/hosts',
    'git status && git diff ../x README.md',
    'git push origin main',
    'git status && git push',
    'docker run -v /:/host alpine',
    'npm i left-pad',
    'npm ci',
  ]) {
    assert.ok(bashProblem(command, root, safe as never), command);
  }
  for (const command of [
    'npm test 2>&1',
    'npm run build && npm test',
    'git log --oneline -5 | head',
    'git commit -m "fix (ui): klammern"',
    'npm run --prefix docs build',
    'npm install --ignore-scripts left-pad@1.3.0 @types/node',
    'docker compose up -d --build app',
    'docker compose restart',
    'docker compose logs --tail=50 app',
    'git diff HEAD~1 -- src 2>/dev/null',
    'git diff main...HEAD --stat',
  ]) {
    assert.equal(bashProblem(command, root, safe as never), null, command);
  }
});

test('Wächter als Hook: sperrt mit Exit-Code 2 und Grund, ohne gültige Richtlinie wird nichts geschrieben', () => {
  const run = (policy: string, input: object) =>
    spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), GUARD_SCRIPT, policy], {
      input: JSON.stringify(input),
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_PROJECT_DIR: root },
    });
  const denied = run(encodePolicy({ create: true, edit: true, scopes: ['docs'] }), write('src/x.ts'));
  assert.equal(denied.status, 2);
  assert.match(denied.stderr, /AIdeation-Wächter: .*erlaubten Ordner/);
  assert.equal(run(encodePolicy(all), write('src/x.ts')).status, 0);
  assert.equal(run('kaputt', write('src/x.ts')).status, 2);
  assert.equal(run(encodePolicy(all), { tool_name: 'Read', tool_input: { file_path: '/etc/hosts' } }).status, 0);
});

test('Wächter: ohne Dateipfad gesperrt; Notebook-Pfade und relative Pfade ohne cwd', () => {
  assert.match(fileProblem({ tool_name: 'Write', tool_input: {} }, all, root) ?? '', /Kein Dateipfad/);
  assert.match(fileProblem({ tool_name: 'Write', tool_input: { file_path: '' } }, all, root) ?? '', /Kein Dateipfad/);
  assert.match(fileProblem({ tool_name: 'Write' }, all, root) ?? '', /Kein Dateipfad/);
  const notebook = { tool_name: 'NotebookEdit', tool_input: { notebook_path: 'docs/a.ipynb' } };
  assert.equal(fileProblem(notebook, all, root), null);
  assert.match(fileProblem(notebook, { create: true, edit: false, scopes: [] }, root) ?? '', /ändern/);
  // Ohne cwd gilt der Projektordner als Ausgangspunkt.
  assert.equal(fileProblem({ tool_name: 'Write', tool_input: { file_path: 'docs/x.md' } }, all, root), null);
  assert.match(fileProblem(write('../ausserhalb.md'), all, root) ?? '', /ausserhalb des Projektordners/);
});

test('Wächter: Gesamtentscheidung je Werkzeug', () => {
  const readOnly: GuardPolicy = { create: false, edit: false, scopes: [], shell: false };
  for (const tool of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']) {
    assert.match(guardProblem(write('docs/alt.md', tool), readOnly, root) ?? '', /nicht freigegeben/, tool);
    assert.equal(guardProblem(write('docs/alt.md', tool), all, root), null, tool);
  }
  const bash = (command: unknown) => ({ tool_name: 'Bash', tool_input: { command }, cwd: root });
  assert.match(guardProblem(bash('git status'), readOnly, root) ?? '', /nur lesen/);
  assert.equal(guardProblem(bash('git status'), all, root), null);
  assert.match(guardProblem(bash('git status > x'), all, root) ?? '', /umleiten/);
  assert.equal(guardProblem(bash(undefined), all, root), null, 'ohne Befehl entscheidet die CLI');
  assert.equal(guardProblem({ tool_name: 'Read', tool_input: { file_path: '/etc/hosts' } }, readOnly, root), null);
  assert.equal(guardProblem({}, readOnly, root), null);
});

test('Wächter: Umleitungen in Anführungszeichen und Befehlsketten', () => {
  assert.equal(bashProblem('git log --grep "a > b"', root), null, 'Text in Anführungszeichen ist keine Umleitung');
  assert.equal(bashProblem("git log --format='%h > %s'", root), null);
  assert.ok(bashProblem('git status || npx eslint', root));
  assert.ok(bashProblem('git status\ngit log --exec=x', root));
  assert.match(bashProblem('cat id_rsa', root) ?? '', /Geheimnisse/);
  const noCheck = () => assert.fail('docker compose ps braucht keine Prüfung');
  assert.equal(bashProblem('docker compose ps', root, noCheck as never), null);
});

test('Wächter: docker compose up wird abgelehnt, wenn die Konfiguration nicht lesbar ist', () => {
  const calls: unknown[][] = [];
  const failing = (...args: unknown[]) => {
    calls.push(args);
    return { status: 1, stdout: '', stderr: 'no configuration file provided' };
  };
  assert.match(
    bashProblem('git status && docker compose up -d', root, failing as never) ?? '',
    /^Start abgelehnt: docker compose config schlug fehl: no configuration file provided/,
  );
  assert.deepEqual(calls[0]?.slice(0, 2), ['docker', ['compose', 'config', '--format', 'json']]);
  assert.equal((calls[0]?.[2] as { cwd: string }).cwd, root);
});

test('Richtlinie: kodieren, dekodieren und sicherer Standard', () => {
  const policy: GuardPolicy = { create: true, edit: false, scopes: ['docs', 'src/app'], shell: false };
  assert.deepEqual(decodePolicy(encodePolicy(policy)), policy);
  assert.deepEqual(decodePolicy(encodePolicy({ create: true, edit: true, scopes: [], shell: true })), {
    create: true,
    edit: true,
    scopes: [],
  });
  for (const value of [undefined, '', 'kaputt', encodePolicy(null as never)]) {
    assert.deepEqual(decodePolicy(value), { create: false, edit: false, scopes: [] }, String(value));
  }
  // Nur echte Wahrheitswerte und gültige Ordner zählen.
  const sloppy = Buffer.from(
    JSON.stringify({ create: 'ja', edit: 1, scopes: ['docs', '../x', '/abs', 'a;b', 'ok/sub'] }),
  ).toString('base64url');
  assert.deepEqual(decodePolicy(sloppy), { create: false, edit: false, scopes: ['docs', 'ok/sub'] });
  const noScopes = Buffer.from(JSON.stringify({ create: true, scopes: 'docs' })).toString('base64url');
  assert.deepEqual(decodePolicy(noScopes), { create: true, edit: false, scopes: [] });
  assert.ok(SCOPE_PATTERN.test('@scope/pkg'));
  assert.ok(!SCOPE_PATTERN.test('a/../b'));
});

test('Wächter als Hook: ungültige Eingabe, scheiternde Prüfung und Projektordner aus cwd', () => {
  const run = (policy: string, input: string, projectDir: string) =>
    spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), GUARD_SCRIPT, policy], {
      input,
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
    });
  const invalid = run(encodePolicy(all), 'kein json', root);
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /AIdeation-Wächter: ungültige Eingabe/);

  const broken = run(encodePolicy(all), JSON.stringify(write('docs/x.md')), join(root, 'gibt-es-nicht'));
  assert.equal(broken.status, 2);
  assert.match(broken.stderr, /AIdeation-Wächter: Prüfung fehlgeschlagen: .*ENOENT/);

  // Ohne CLAUDE_PROJECT_DIR gilt das cwd der Eingabe als Projektordner.
  const scoped = encodePolicy({ create: true, edit: true, scopes: ['docs'] });
  assert.equal(run(scoped, JSON.stringify(write('docs/x.md')), '').status, 0);
  assert.equal(run(scoped, JSON.stringify(write('src/x.ts')), '').status, 2);
});

test('Lokales Modell: dieselben Datei- und Befehlsrechte wie die Claude-CLI', async () => {
  const { executeTool } = await import('./ollama-tools.js');
  let executed = false;
  const context = {
    cwd: root,
    canWrite: true,
    files: { create: true, edit: false, scopes: ['docs'] },
    commands: ['Bash(git status:*)'],
    databaseUrl: 'postgresql://x',
    changed: new Set<string>(),
    backupRoot: join(root, '.backup'),
    execute: async () => {
      executed = true;
      return { exitCode: 0, durationMs: 0, output: '' };
    },
    timeoutMs: 1000,
  };
  const call = (name: string, args: Record<string, unknown>) =>
    executeTool(context, { function: { name, arguments: args } } as never);
  assert.match(await call('write_file', { path: 'src/x.ts', content: 'x' }), /erlaubten Ordner/);
  assert.match(await call('write_file', { path: 'docs/alt.md', content: 'x' }), /ändern/);
  assert.match(await call('write_file', { path: 'docs/neu2.md', content: 'x' }), /geschrieben/);
  assert.match(await call('run_command', { command: 'git diff' }), /nicht freigegeben/);
  assert.match(await call('run_sql', { sql: 'select 1' }), /nicht freigegeben/);
  assert.equal(executed, false);
});

test('Wächter: gesperrte Unterbefehle auch in Anführungszeichen, mit Backslash und abschaltbarem --ignore-scripts', () => {
  for (const command of [
    'git "push" origin main',
    "git 'push'",
    'git pu\\sh',
    'docker "run" alpine',
    'npm "install" left-pad',
    'npm install --ignore-scripts left-pad --ignore-scripts=false',
    'npm install --ignore-scripts left-pad --no-ignore-scripts',
  ]) {
    assert.ok(bashProblem(command, root), command);
  }
  for (const command of ['git status', 'git log --oneline', 'git diff', 'npm test', 'npm run build']) {
    assert.equal(bashProblem(command, root), null, command);
  }
});

test('Wächter: abgekürzte Git-Optionen, mehrstellige File-Deskriptoren und „<>“ sind gesperrt', () => {
  for (const command of [
    "git fetch --upload-pa='sh -c id' .",
    'git log --outp=/tmp/x',
    'git diff --no-ind /etc/hosts x',
    'git log "--output=/tmp/x"',
    'git log --ext-d',
    'git diff --textc',
    'git grep -Ovim foo',
    'git grep --open-files=vim foo',
    'git format-patch --output-directory /tmp/x',
    'git status 10>~/.bashrc',
    'git status 99>>notes.txt',
    'git status <>notes.txt',
    'git status 0<>notes.txt',
    'npm run build -C /tmp/anderer-ordner',
  ]) {
    assert.ok(bashProblem(command, root), command);
  }
  for (const command of [
    'git status',
    'git log --oneline --stat',
    'git diff --text',
    'git diff --stat HEAD~1',
    'git log --grep "a > b"',
    'git commit -m "neue Option --output dokumentiert"',
    'npm test',
    'npm run build',
    'npm test 2>&1',
    'npm test 10>&1',
    'git status 2>/dev/null',
  ]) {
    assert.equal(bashProblem(command, root), null, command);
  }
});

test('Wächter: Links ins Leere werden nicht beschrieben (Ziel läge ungeprüft ausserhalb)', () => {
  symlinkSync(join(tmpdir(), `fehlt-${process.pid}`, 'zprofile'), join(root, 'out.txt'));
  symlinkSync(join(tmpdir(), `fehlt-${process.pid}`), join(root, 'leer'));
  assert.match(fileProblem(write('out.txt'), all, root) ?? '', /Link ins Leere/);
  assert.match(fileProblem(write('out.txt', 'Edit'), all, root) ?? '', /Link ins Leere/);
  assert.match(fileProblem(write('leer/x.md'), all, root) ?? '', /Link ins Leere/);
  assert.equal(fileProblem(write('docs/neu2.md'), all, root), null);
});
