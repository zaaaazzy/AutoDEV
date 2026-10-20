import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { bashProblem, encodePolicy, fileProblem, GUARD_SCRIPT, type GuardPolicy } from './agent-guard.js';

const root = mkdtempSync(join(tmpdir(), 'guard-'));
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
