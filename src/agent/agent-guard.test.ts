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
  for (const path of [
    '.claude/settings.json',
    '.git/config',
    '.husky/pre-commit',
    '.env',
    'src/.env.local',
    '.mcp.json',
    'k.pem',
  ]) {
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

test('Wächter: git fetch/pull nur von Remotes, npm nur aus der Standard-Registry (kein Abfluss an fremde Hosts)', () => {
  const remotes = () => ({ status: 0, stdout: 'origin\nupstream\n', stderr: '' });
  for (const command of [
    'git fetch https://x.example/a',
    'git fetch "https://x.example/a"',
    'git fetch git@host:r',
    "git fetch 'git@host:r'",
    'git fetch file:///tmp/repo',
    'git fetch ext::sh',
    'git fetch /tmp/repo',
    'git fetch ../other',
    'git fetch x.example:repo',
    'git fetch -- https://x.example/a',
    'git fetch origin https://x.example/a',
    'git fetch evil',
    'git fetch origin main:refs/heads/x',
    'git pull --ff-only https://x.example/a main',
    'git pull --ff-only "https://x.example/a" main',
    'git pull --ff-only git@host:r main',
    'npm ci --ignore-scripts --registry=https://x.example',
    'npm ci --ignore-scripts "--registry=https://x.example"',
    'npm ci --ignore-scripts --registry https://x.example',
    'npm ci --ignore-scripts --reg=https://x.example',
    'npm install --ignore-scripts --@scope:registry=https://x.example @scope/a',
    'npm install --ignore-scripts --//x.example/:_authToken=abc left-pad',
    'npm ci --ignore-scripts --proxy=http://x.example',
    'npm ci --ignore-scripts --https-proxy=http://x.example',
    'npm ci --ignore-scripts --noproxy=*',
    'npm ci --ignore-scripts --replace-registry-host=always',
    'npm_config_registry=https://x.example npm ci --ignore-scripts',
    'npm isntall --ignore-scripts https://x.example/a.tgz',
    'npm in --ignore-scripts git+ssh://git@x.example/r.git',
  ]) {
    assert.ok(bashProblem(command, root, remotes as never), command);
  }
  for (const command of [
    'git fetch',
    'git fetch origin',
    'git fetch origin main',
    'git fetch upstream feature/x',
    'git fetch --prune origin',
    'git pull --ff-only',
    'git pull --ff-only origin main',
    'npm ci --ignore-scripts',
    'npm install --ignore-scripts left-pad',
  ]) {
    assert.equal(bashProblem(command, root, remotes as never), null, command);
  }
  // Ohne Abfrage der Remotes (lokales Modell) gilt nur origin.
  assert.equal(bashProblem('git fetch origin', root, null), null);
  assert.ok(bashProblem('git fetch upstream', root, null));
});

test('Wächter: .npmrc ist geschützt (Registry und Proxy liessen sich sonst dort umstellen)', () => {
  assert.match(fileProblem(write('.npmrc'), all, root) ?? '', /geschützt/);
  assert.match(fileProblem(write('frontend/.npmrc'), all, root) ?? '', /geschützt/);
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
  const secret = run(encodePolicy(all), { tool_name: 'Read', tool_input: { file_path: '.env' }, cwd: root });
  assert.equal(secret.status, 2);
  assert.match(secret.stderr, /\.env: Geheimnisse/);
});

test('Wächter: Read, Grep und Glob auf Geheimnisse sind für jede Richtlinie gesperrt, nur der Pfad wird gemeldet', () => {
  mkdirSync(join(root, 'config'));
  mkdirSync(join(root, 'certs'));
  writeFileSync(join(root, '.env'), 'GEHEIM=hunter2');
  writeFileSync(join(root, 'config', '.env.production'), 'GEHEIM=hunter2');
  writeFileSync(join(root, 'certs', 'server.key'), 'GEHEIM=hunter2');
  symlinkSync(join(root, '.env'), join(root, 'docs', 'notizen.txt'));
  const readOnly: GuardPolicy = { create: false, edit: false, scopes: [], shell: false };
  const read = (file_path: string, cwd = root) => ({ tool_name: 'Read', tool_input: { file_path }, cwd });
  for (const policy of [readOnly, all]) {
    for (const input of [
      read('.env'),
      read('config/.env.production'),
      read('certs/server.key'),
      read(join(root, '.env')),
      read('../.env', join(root, 'docs')),
      read('docs/../certs/server.key'),
      read('docs/notizen.txt'),
      read('CERTS/Server.KEY'),
      read('tls/server.pem'),
      read('~/.ssh/id_ed25519'),
      read('/home/x/.ssh/config'),
      read('.npmrc'),
      read('frontend/.npmrc'),
      read('~/.npmrc'),
      read('~/.netrc'),
      read('.git-credentials'),
      read('.env.example'),
      { tool_name: 'Grep', tool_input: { pattern: '_authToken', path: '.npmrc' }, cwd: root },
      { tool_name: 'Grep', tool_input: { pattern: '_authToken', glob: '**/.npmrc' }, cwd: root },
      { tool_name: 'Glob', tool_input: { pattern: '**/.npmrc' }, cwd: root },
      { tool_name: 'NotebookRead', tool_input: { notebook_path: '.env' }, cwd: root },
      { tool_name: 'Grep', tool_input: { pattern: 'GEHEIM', path: 'config/.env.production' }, cwd: root },
      { tool_name: 'Grep', tool_input: { pattern: 'GEHEIM', glob: '*.{pem,key}' }, cwd: root },
      { tool_name: 'Grep', tool_input: { pattern: 'GEHEIM', glob: '**/.env*' }, cwd: root },
      { tool_name: 'Glob', tool_input: { pattern: 'certs/*.key' }, cwd: root },
      { tool_name: 'Glob', tool_input: { pattern: '*', path: '.ssh' }, cwd: root },
    ]) {
      const problem = guardProblem(input, policy, root);
      assert.match(problem ?? '', /Geheimnisse/, JSON.stringify(input));
      assert.doesNotMatch(problem ?? '', /hunter2/);
    }
  }
  // Kein Überblocken: gewöhnliche Dateien, Ordner und Muster bleiben lesbar.
  for (const input of [
    read('docs/alt.md'),
    read('docs/env.md'),
    read('src/environments/environment.ts'),
    read('src/keyboard.ts'),
    read('docs/npmrc.md'),
    read('/etc/hosts'),
    { tool_name: 'Grep', tool_input: { pattern: 'env', path: 'docs', glob: '*.md' }, cwd: root },
    { tool_name: 'Grep', tool_input: { pattern: '.env' }, cwd: root },
    { tool_name: 'Glob', tool_input: { pattern: 'src/**/*.ts' }, cwd: root },
  ]) {
    assert.equal(guardProblem(input, readOnly, root), null, JSON.stringify(input));
  }
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

test('Wächter: escapte Anführungszeichen verstecken keine Umleitung, Ersetzung oder Hintergrund-Befehle', () => {
  for (const command of [
    "npm test \\' > /tmp/x \\'",
    "npm test \\'$(id)\\'",
    "git status \\' & touch x \\'",
    'npm test \\" > /tmp/x \\"',
    "npm test \\'`id`\\'",
    "npm test $'a' > /tmp/x",
    "npm test $'\\'' > /tmp/x",
    `npm test "a 'b' \\" > /tmp/x"`,
    `npm test "it's" > /tmp/x`,
    `npm test 'a' "$(id)"`,
  ]) {
    assert.ok(bashProblem(command, root), command);
  }
});

test('Wächter: Datei-Befehle aus der acceptEdits-Liste der CLI sind gesperrt, auch versteckt', () => {
  // acceptEdits gibt diese sieben Befehle ohne --allowedTools-Regel frei; nur der Wächter hält sie auf.
  for (const name of ['mkdir', 'touch', 'rm', 'rmdir', 'mv', 'cp', 'sed']) {
    for (const command of [
      `${name} a b`,
      `"${name}" a b`,
      `'${name}' a b`,
      `\\${name} a b`,
      `/bin/${name} a b`,
      `git status && ${name} a b`,
      `git status; ${name} a b`,
      `git log | xargs ${name} a`,
      `git status\n${name} a b`,
      `env ${name} a b`,
      `"env" ${name} a b`,
      `command ${name} a b`,
      `"command" ${name} a b`,
      `sudo ${name} a b`,
      `git status $(${name} a b)`,
      `git status \`${name} a b\``,
    ]) {
      assert.match(bashProblem(command, root) ?? '', /gesperrt/, command);
    }
  }
  for (const command of [
    'rm -rf backend',
    "sed -i '' s/a/b/ x.ts",
    "sed -i '' 's/a/b/' backend/x.ts",
    'cp a b',
    'mv a b',
    'rm ~/Library/Logs/x.log',
    'ln -s /etc/hosts x',
    'git log | tee notes.txt',
    'truncate -s 0 README.md',
    'install -m 644 a b',
    'dd if=/dev/zero of=x',
    'find . -delete',
    'find src -name "*.ts" -exec sed -i "" s/a/b/ {} +',
    '$X a b',
    'r? a b',
  ]) {
    assert.match(bashProblem(command, root) ?? '', /gesperrt/, command);
  }
  for (const command of [
    'find src -name "*.ts"',
    'npx --no-install tsc --noEmit',
    'node --check src/x.js',
    'git log --grep rm',
    'npm run build && npm test',
  ]) {
    assert.equal(bashProblem(command, root), null, command);
  }
});

test('Wächter: node nur als --version oder --check <datei>, ohne Lade-Optionen', () => {
  for (const command of [
    'node --check --import data:text/javascript,1 a.js',
    'node --check -r ./x.js a.js',
    'node --check --require=./x.js a.js',
    'node --check=a.js',
    'node --check a.js b.js',
    'node -e 1',
    'node a.js',
    'export NODE_OPTIONS=--import=./x.js; node --check a.js',
    // Fundfall des Auftrags und weitere Lade-Optionen, auch ohne Leerzeichen, mit = und in Anführungszeichen.
    `node --check --import "data:text/javascript,import('node:child_process').then(c=>c.execSync('id'))" ok.js`,
    'node --check -r ./x.js ok.js',
    'node --check -r./x.js ok.js',
    'node --check --import=./x.mjs ok.js',
    'node --check --loader ./x.mjs ok.js',
    'node --check --experimental-loader=./x.mjs ok.js',
    'node --check "--import" ./x.mjs ok.js',
    'node --check ok.js --import ./x.mjs',
    'node -r ./x.js --check ok.js',
    'node -c ok.js',
    'node --check -',
    'node --check',
    // Datei muss eine relative Projektdatei sein.
    'node --check /etc/x.js',
    'node --check ../x.js',
    'node --check src/../../x.js',
    'node --check data:text/javascript,1',
    'node --check file:///tmp/x.js',
    'node --check $F',
    // Umgebung und Verkettung.
    'NODE_OPTIONS=--require=./x.js node --check ok.js',
    'env NODE_OPTIONS=--import=./x.mjs node --check ok.js',
    'node --check ok.js && node --import ./x.mjs ok.js',
  ]) {
    assert.match(bashProblem(command, root) ?? '', /gesperrt|erlaubt sind nur/, command);
  }
  for (const command of [
    'node --check src/x.js',
    'node --check src/a.js',
    'node --check ./src/a.js',
    'node --check "src/a b.js"',
    'node --version',
  ]) {
    assert.equal(bashProblem(command, root), null, command);
  }
});

test('Wächter: gewöhnliche Quotes bleiben erlaubt', () => {
  for (const command of [
    'git log --grep "a > b"',
    `git log --format='%h > %s'`,
    `git log --grep "it's"`,
    `git log --grep 'say "hi" > you'`,
  ]) {
    assert.equal(bashProblem(command, root), null, command);
  }
});

test('Wächter-Tokenizer: Escapes, Fortsetzungszeilen und Shell-Konstrukte verstecken nichts', () => {
  for (const command of [
    // Aus dem Code-Review: escapte Quotes vor Ersetzung bzw. Umleitung.
    "git log \\' $(id) \\'",
    'git log \\" > /tmp/pwned \\"',
    // Fortsetzungszeile: Backslash + Zeilenumbruch trennt keinen Befehl, die Option gehört zu git.
    'git log \\\n--output=/tmp/x',
    'git \\\n-c core.pager=sh log',
    'git status \\\n> /tmp/x',
    // Ersetzungen in "…" wirken, ${…} kann eine verstecken.
    'git log "$(id)"',
    'git log "`id`"',
    'git log ${X:-$(id)}',
    'git log $((1+2))',
    // Variablen in git/npm/docker: export setzt sie vorher, der Wächter sähe den Wert nicht.
    'export X=--output=/tmp/x; git log $X',
    "git log $'--output=/tmp/x'",
    'npm run build "$X"',
    // Schlüsselwörter starten Konstrukte, deren Befehle sonst niemand prüfte.
    '! rm -rf src',
    'if true; then rm x; fi',
    'while true; do rm x; done',
    '{ rm x; }',
    'time rm x',
    // Heredocs, Syntaxfehler und offene Enden.
    'git log <<EOF\nx\nEOF',
    'git status &&',
    'git status |',
    '&& git status',
    'git status;; git log',
    'git status >',
    'git log --grep x\\',
    "git log --grep 'offen",
    // Umleitungen in allen Formen.
    'git status >&/tmp/x',
    'git status &>>/tmp/x',
    'git status 2> /tmp/x',
    'git status >| x',
    'git status > "$HOME/x"',
  ]) {
    assert.match(bashProblem(command, root) ?? '', /gesperrt|zerlegen/, JSON.stringify(command));
  }
  for (const command of [
    'git log --grep "x; rm y"',
    "git log --grep 'a | b && c'",
    "git log --grep 'C:\\'",
    "git log --grep '$(id)'",
    'git log --grep "\\$HOME"',
    'git status &&\ngit log --oneline',
    'git log --oneline # Kommentar > x',
    'npm test 2>&1 | head',
    'git status >&2',
    'git status 2>"/dev/null"',
    'git log --grep "a\\\\b"',
  ]) {
    assert.equal(bashProblem(command, root), null, JSON.stringify(command));
  }
});

test('Wächter: hinter timeout, nice, stdbuf und ionice wird der eigentliche Befehl geprüft', () => {
  for (const command of [
    "timeout 60 sh -c 'id'",
    'timeout 60 git push',
    'timeout 5 nice -n 5 git push',
    'timeout 5 nice -n 5 stdbuf -o0 git push origin main',
    'ionice -c2 -n7 git push',
    'stdbuf -oL npm publish',
    'timeout -k 3 60 git push',
    'timeout --signal=KILL 60 git reset --hard',
    'nice -5 docker run alpine',
    '"timeout" 60 git push',
    '\\timeout 60 git push',
    '/usr/bin/timeout 60 git push',
    't""imeout 60 git push',
    '$X 60 git push',
    'timeout $T git push',
    'timeout 60 $X push',
    'timeout 60 env X=1 git status',
    'timeout 60 rm -rf src',
    'timeout 60 find . -exec sh {} +',
    'timeout 60 cd .git/hooks',
    'timeout 60 npx tsc',
    'timeout 60 git status > x',
  ]) {
    assert.match(bashProblem(command, root) ?? '', /gesperrt|Wrapper|nur mit/, command);
  }
  // Unklare Optionen, kein Befehl dahinter oder zu tiefe Verschachtelung: gesperrt (fail-closed).
  for (const command of [
    'timeout git status',
    'timeout 60',
    'timeout --kill-after 3 60 git status',
    'nice --wild git status',
    'ionice -p 1',
    'stdbuf -o $M git status',
    'timeout 1 timeout 1 timeout 1 timeout 1 timeout 1 git status',
  ]) {
    assert.match(bashProblem(command, root) ?? '', /Wrapper/, command);
  }
  for (const command of [
    'timeout 60 npm test',
    'timeout 5 nice -n 5 git status',
    'nice -n 10 npx --no-install tsx --test src/agent/agent-guard.test.ts',
    'stdbuf -oL git log --oneline',
    'timeout -s TERM 2m npm run typecheck',
    'git status && timeout 30 git diff',
  ]) {
    assert.equal(bashProblem(command, root), null, command);
  }
});

test('Wächter: Shell-Builtins, die spätere Befehle verändern, sind gesperrt', () => {
  for (const command of [
    'export GIT_DIR=/tmp/x',
    'declare -x A=1',
    'unset PATH',
    'set -o allexport',
    'alias git=sh',
    'cd .git/hooks && git status',
    'cd frontend',
    'pushd /tmp',
    'source x.sh',
    '. ./x.sh',
    'eval git push',
    "trap 'id' EXIT",
    'hash -p /bin/sh git',
    '"cd" /tmp',
    'git status; cd /tmp',
  ]) {
    assert.match(bashProblem(command, root) ?? '', /gesperrt/, command);
  }
});

test('Wächter: awk startet über system() Programme und ist gesperrt; Abnahme-Befehle bleiben erlaubt', () => {
  for (const command of ["awk 'BEGIN{system(x)}'", 'gawk -f x.awk', "git log | awk '{print > x}'"]) {
    assert.match(bashProblem(command, root) ?? '', /gesperrt/, command);
  }
  for (const command of [
    'npx --no-install tsx --test src/agent/agent-guard.test.ts',
    'npm run typecheck',
    'git fetch origin main',
    'npm ci --ignore-scripts',
  ]) {
    assert.equal(bashProblem(command, root, null), null, command);
  }
});

test('Wächter als Hook: Projektordner aus der Richtlinie geht vor CLAUDE_PROJECT_DIR und cwd', (t) => {
  const other = mkdtempSync(join(tmpdir(), 'guard-other-'));
  t.after(() => rmSync(other, { recursive: true, force: true }));
  const run = (policy: string, input: object) =>
    spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), GUARD_SCRIPT, policy], {
      input: JSON.stringify(input),
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_PROJECT_DIR: other },
    });
  const pinned = encodePolicy({ ...all, root });
  // Ohne root in der Richtlinie gälte der fremde Ordner aus CLAUDE_PROJECT_DIR als Projekt.
  assert.equal(run(encodePolicy(all), { ...write(join(other, 'x.md')), cwd: other }).status, 0);
  const outside = run(pinned, { ...write(join(other, 'x.md')), cwd: other });
  assert.equal(outside.status, 2);
  assert.match(outside.stderr, /ausserhalb des Projektordners/);
  assert.equal(run(pinned, write(join(root, 'docs', 'neu-hook.md'))).status, 0);
  assert.equal(decodePolicy(pinned).root, root);
  assert.equal(decodePolicy(encodePolicy({ ...all, root: 'relativ' })).root, undefined);
});
