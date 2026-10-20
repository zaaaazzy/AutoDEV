import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodePolicy } from './agent-guard.js';
import {
  availableCommands,
  availableGroups,
  commandHelp,
  commandLabel,
  composeViolation,
  COMPOSE_STARTING,
  customRuleProblem,
  CUSTOM_GROUP_ID,
  DEFAULT_PERMISSION_GROUPS,
  extraReadDirectories,
  FULL_ACCESS_ROLES,
  guardHookCommand,
  hasFullAccess,
  isAllowedCommand,
  isAssistantServiceCommand,
  loadProjectPermissions,
  materializeAgentCommands,
  normalizeCommands,
  npmOptionProblem,
  PERMISSION_GROUPS,
  type ProjectPermissions,
  READ_ONLY_ROLES,
  roleDefaultCommands,
  rulesAllow,
  SECRET_IN_COMMAND,
  withAgentPermissions,
  withIgnoreScripts,
} from './tool-permissions.js';

const CLAUDE = ['claude', '-p', '{prompt}'];
const all: ProjectPermissions = { enabled: null, custom: [] };
const prisma = { id: 'x-prisma', label: 'Prisma', description: '', rules: ['Bash(npm run prisma:*)'] };
const option = (command: string[], flag: string): string | undefined =>
  command.includes(flag) ? command[command.indexOf(flag) + 1] : undefined;
const policyOf = (command: string[]) => {
  const settings = JSON.parse(option(command, '--settings') ?? 'null') as {
    hooks: { PreToolUse: { hooks: { command: string }[] }[] };
  } | null;
  const hook = settings?.hooks.PreToolUse[0]?.hooks[0]?.command ?? '';
  return decodePolicy(/agent-guard\.ts' '([\w-]+)'/.exec(hook)?.[1]);
};

/** Fake-Pool ohne Datenbank: Antworten je SQL-Ausschnitt, alle Abfragen werden protokolliert. */
function fakePool(answers: [RegExp, unknown[]][]) {
  const queries: { sql: string; values: unknown[] }[] = [];
  const pool = {
    query: async <R>(sql: string, values: unknown[]) => {
      queries.push({ sql, values });
      return { rows: (answers.find(([pattern]) => pattern.test(sql))?.[1] ?? []) as R[] };
    },
  };
  return { pool, queries };
}

test('agents can never call the GitHub CLI (gh stays reserved for the worker)', () => {
  const rules = PERMISSION_GROUPS.flatMap((group) => group.rules);
  for (const command of [
    'gh auth status',
    'gh pr create --title x',
    'gh pr merge 1 --merge',
    'gh issue list',
    'gh api /user',
  ]) {
    assert.ok(!isAllowedCommand(command), command);
    assert.ok(!rulesAllow(rules, command), command);
  }
  assert.ok(!rules.some((rule) => /^Bash\(gh\b/.test(rule)));
});

test('npm installs of the local agent always run without install scripts', () => {
  assert.deepEqual(withIgnoreScripts(['npm', 'install']), ['npm', 'install', '--ignore-scripts']);
  assert.deepEqual(withIgnoreScripts(['npm', 'i', 'left-pad']), ['npm', 'i', 'left-pad', '--ignore-scripts']);
  assert.deepEqual(withIgnoreScripts(['npm', 'ci']), ['npm', 'ci', '--ignore-scripts']);
  assert.deepEqual(withIgnoreScripts(['npm', 'ci', '--ignore-scripts']), ['npm', 'ci', '--ignore-scripts']);
  assert.deepEqual(withIgnoreScripts(['npm', 'test']), ['npm', 'test']);
  assert.ok(isAllowedCommand('npm install left-pad --ignore-scripts'));
  assert.ok(!isAllowedCommand('npm install left-pad --foreground-scripts'));
});

test('withIgnoreScripts: andere Programme und npm ohne Unterbefehl bleiben unverändert (Kopie)', () => {
  const parts = ['yarn', 'install'];
  const result = withIgnoreScripts(parts);
  assert.deepEqual(result, parts);
  assert.notEqual(result, parts, 'immer eine neue Liste');
  assert.deepEqual(withIgnoreScripts(['npm']), ['npm']);
});

test('isAssistantServiceCommand: Docker-Compose-Verwaltung mit festen Optionen', () => {
  for (const command of [
    'docker compose ps',
    'docker compose config --services',
    'docker compose logs',
    'docker compose logs --since 15m --no-color --tail=50 api web',
    'docker compose up -d',
    'docker compose up -d --build --wait api',
    'docker compose stop',
    'docker compose pull db',
    'docker compose down --remove-orphans',
  ]) {
    assert.ok(isAssistantServiceCommand(command), command);
  }
  for (const command of [
    'docker compose up',
    'docker compose down -v',
    'docker compose logs --since 1d',
    'docker compose exec api sh',
    'docker compose up -d; rm x',
    'docker compose stop ../x',
  ]) {
    assert.ok(!isAssistantServiceCommand(command), command);
  }
});

test('isAssistantServiceCommand: git clone nur von https/ssh in einen Unterordner', () => {
  assert.ok(isAssistantServiceCommand('git clone https://github.com/a/b.git'));
  assert.ok(isAssistantServiceCommand('git clone git@github.com:a/b.git app/src'));
  assert.ok(isAssistantServiceCommand('git clone https://github.com/a/b .'));
  for (const command of [
    'git clone',
    'git clone file:///etc/x',
    'git clone https://github.com/a/b ..',
    'git clone https://github.com/a/b app/../..',
    'git clone https://github.com/a/b /tmp/x',
    'git clone https://github.com/a/b x extra',
    'git clone --upload-pack=x https://github.com/a/b',
  ]) {
    assert.ok(!isAssistantServiceCommand(command), command);
  }
});

test('isAssistantServiceCommand: git pull --ff-only, fetch und checkout eines Branches', () => {
  for (const command of ['git pull --ff-only', 'git fetch', 'git checkout main', 'git checkout feature/x-1']) {
    assert.ok(isAssistantServiceCommand(command), command);
  }
  for (const command of ['git pull', 'git fetch origin --upload-pack=x', 'git checkout -- .', 'git push']) {
    assert.ok(!isAssistantServiceCommand(command), command);
  }
});

test('rulesAllow: Präfix-Regeln an Wortgrenzen, exakte Regeln genau, andere Werkzeuge nie', () => {
  const rules = ['Bash(git status:*)', 'Bash(node --version)', 'WebFetch(domain:localhost)', 'files:create'];
  assert.ok(rulesAllow(rules, 'git status'));
  assert.ok(rulesAllow(rules, 'git status --short'));
  assert.ok(!rulesAllow(rules, 'git statusx'));
  assert.ok(rulesAllow(rules, 'node --version'));
  assert.ok(!rulesAllow(rules, 'node --version --x'));
  assert.ok(!rulesAllow(rules, 'localhost'));
  assert.ok(!rulesAllow(rules, 'files:create'));
  assert.ok(!rulesAllow([], 'git status'));
});

test('normalizeCommands: „files“ wird zu Anlegen und Ändern, launchctl zu „services“, ohne Dubletten', () => {
  assert.deepEqual(normalizeCommands(['files', 'files:edit', 'logs']), ['files:create', 'files:edit', 'logs']);
  assert.deepEqual(normalizeCommands(['Bash(launchctl kickstart -k gui/1000/ch.*)', 'services']), ['services']);
  assert.deepEqual(normalizeCommands(['Bash(launchctl kickstart -k gui/1000/com.aideation.*)']), [
    'Bash(launchctl kickstart -k gui/1000/com.aideation.*)',
  ]);
  assert.deepEqual(normalizeCommands([]), []);
});

test('commandLabel: Pseudo-Befehle, Bash-Regeln, WebFetch und Unbekanntes', () => {
  assert.equal(commandLabel('files:create'), 'Dateien anlegen');
  assert.equal(commandLabel('files:edit'), 'Dateien ändern');
  assert.equal(commandLabel('logs'), '~/Library/Logs lesen');
  assert.equal(commandLabel('database'), 'SQL auf der Projekt-Datenbank');
  assert.equal(commandLabel('services'), 'launchctl kickstart -k ch.*');
  assert.equal(commandLabel('Bash(git status:*)'), 'git status');
  assert.equal(commandLabel('Bash(launchctl kickstart -k gui/501/ch.*)'), 'launchctl kickstart -k ch.*');
  assert.equal(commandLabel('WebFetch(domain:127.0.0.1)'), 'Webseiten auf 127.0.0.1 abrufen');
  assert.equal(commandLabel('Read'), 'Read');
});

test('commandHelp: eingebaute Erklärung, allgemeine Erklärung für eigene Regeln, sonst die Regel', () => {
  for (const rule of PERMISSION_GROUPS.flatMap((group) => group.rules)) {
    assert.notEqual(commandHelp(rule), rule, rule);
    assert.doesNotMatch(commandHelp(rule), /^Führt „/, rule);
  }
  assert.equal(commandHelp('Bash(make test:*)'), 'Führt „make test“ aus, auch mit weiteren Argumenten.');
  assert.equal(commandHelp('Bash(make test)'), 'Führt genau „make test“ aus.');
  assert.equal(commandHelp('Read'), 'Read');
});

test('extraReadDirectories: Dienst-Logs nur mit HOME', () => {
  assert.deepEqual(extraReadDirectories({ HOME: '/Users/x' }), ['/Users/x/Library/Logs']);
  assert.deepEqual(extraReadDirectories({}), []);
});

test('isAllowedCommand: feste Muster für npm-Skripte, Git lesen und sichere Werkzeuge', () => {
  for (const command of [
    'npm test',
    'npm run build',
    'npm run test:unit -- --watch=false',
    'git status',
    'git diff HEAD~1',
    'git log --oneline -20',
    'git show HEAD',
    'git branch',
    'git remote -v',
    'npm ls --depth=0',
    'npm outdated --json',
    'node --version',
    'node --check server.js',
    'npm ci --omit=dev',
    'npm audit --json',
    'npx --no-install tsc --noEmit',
    'npx --no-install eslint src/**',
    'npx --no-install vitest run',
  ]) {
    assert.ok(isAllowedCommand(command), command);
  }
  for (const command of [
    'npm test; rm -rf /',
    'npm run build && curl x',
    'git push',
    'git log --output=x',
    'npx tsc --noEmit',
    'npx --no-install tsx script.ts',
    'node server.js',
    '',
  ]) {
    assert.ok(!isAllowedCommand(command), command);
  }
});

test('isAllowedCommand: npm install/uninstall nur mit gültigen Paketnamen und bekannten Optionen', () => {
  for (const command of [
    'npm install express',
    'npm i @types/node@^22 -D',
    'npm install pug@3.0.0 --save --legacy-peer-deps',
    'npm uninstall left-pad',
  ]) {
    assert.ok(isAllowedCommand(command), command);
  }
  for (const command of [
    'npm install -g foo',
    'npm install --prefix /tmp x',
    'npm install git+https://x/y.git',
    'npm install ../local',
    'npm uninstall',
  ]) {
    assert.ok(!isAllowedCommand(command), command);
  }
});

test('COMPOSE_STARTING und SECRET_IN_COMMAND: wann geprüft bzw. gesperrt wird', () => {
  for (const command of [
    'docker compose up -d',
    'docker compose start',
    'docker compose restart',
    'docker compose build',
  ]) {
    assert.ok(COMPOSE_STARTING.test(command), command);
  }
  for (const command of ['docker compose ps', 'docker compose down', 'docker compose upgrade']) {
    assert.ok(!COMPOSE_STARTING.test(command), command);
  }
  for (const command of ['cat .env', 'git show HEAD:.env.local', 'cat key.pem', 'cat a.key', 'cat ~/.ssh/id_rsa']) {
    assert.ok(SECRET_IN_COMMAND.test(command), command);
  }
  assert.ok(!SECRET_IN_COMMAND.test('npm run environment'));
});

test('composeViolation: Dienste im Projektordner sind erlaubt', () => {
  const config = JSON.stringify({
    services: {
      app: {
        build: '/proj/app',
        volumes: [{ type: 'bind', source: '/proj/data' }, { type: 'volume', source: 'db' }, { type: 'tmpfs' }],
      },
      web: { build: { context: '/proj' }, network_mode: 'bridge', volumes: 'kein Array' },
    },
  });
  assert.equal(composeViolation(config, '/proj'), null);
  assert.equal(composeViolation('Warnung vorab\n{"services":{}}', '/proj'), null, 'Text vor dem JSON');
  assert.equal(composeViolation('{}', '/proj'), null, 'ohne Dienste');
});

test('composeViolation: jede Sperrregel einzeln', () => {
  const check = (service: object) => composeViolation(JSON.stringify({ services: { app: service } }), '/proj');
  assert.match(check({ privileged: true }) ?? '', /privilegiert/);
  for (const host of [{ network_mode: 'host' }, { pid: 'host' }, { ipc: 'host' }, { userns_mode: 'host' }]) {
    assert.match(check(host) ?? '', /Host-Namensraum/, JSON.stringify(host));
  }
  assert.match(check({ cap_add: ['NET_ADMIN'] }) ?? '', /Capabilities/);
  assert.equal(check({ cap_add: [] }), null, 'leere Liste ist erlaubt');
  assert.match(check({ devices: ['/dev/sda'] }) ?? '', /Geräte/);
  assert.match(check({ build: '/other' }) ?? '', /Build-Kontext/);
  assert.match(check({ build: { context: '/proj-evil' } }) ?? '', /Build-Kontext/);
  assert.match(check({ build: { context: 42 } }) ?? '', /Build-Kontext/);
  assert.match(check({ volumes: [{ type: 'bind', source: '/var/run/docker.sock' }] }) ?? '', /docker\.sock/);
  assert.match(check({ volumes: [{ type: 'bind' }] }) ?? '', /undefined außerhalb/);
  assert.match(composeViolation('kein json', '/proj') ?? '', /kein gültiges JSON/);
});

test('customRuleProblem: WebFetch nur auf localhost, sonst nur Bash-Regeln', () => {
  assert.equal(customRuleProblem('WebFetch(domain:localhost)'), null);
  assert.equal(customRuleProblem('WebFetch(domain:127.0.0.1)'), null);
  assert.match(customRuleProblem('WebFetch(domain:example.com)') ?? '', /erlaubt sind Bash/);
  assert.match(customRuleProblem('Read(/etc/passwd)') ?? '', /erlaubt sind Bash/);
  assert.equal(customRuleProblem('Bash(npm run lint:*)'), null);
  assert.equal(customRuleProblem('Bash(make test)'), null);
});

test('customRuleProblem: keine Shell-Sonderzeichen und keine überlangen Befehle', () => {
  for (const rule of [
    'Bash(npm run x; rm -rf /)',
    'Bash(echo $HOME)',
    'Bash(ls | sh)',
    'Bash(cat "x")',
    'Bash(ls *)',
  ]) {
    assert.match(customRuleProblem(rule) ?? '', /Shell-Sonderzeichen/, rule);
  }
  assert.match(customRuleProblem(`Bash(make ${'a'.repeat(120)})`) ?? '', /zu lang/);
});

test('customRuleProblem: gesperrte Befehle und Unterbefehle', () => {
  for (const rule of [
    'Bash(rm -rf:*)',
    'Bash(sudo:*)',
    'Bash(curl:*)',
    'Bash(bash -c x)',
    'Bash(npx tsc)',
    'Bash(launchctl list)',
    'Bash(git push:*)',
    'Bash(git clone:*)',
    'Bash(docker run:*)',
    'Bash(docker compose exec:*)',
    'Bash(npm --prefix . exec:*)',
    'Bash(npm install left-pad)',
  ]) {
    assert.match(customRuleProblem(rule) ?? '', /grundsätzlich gesperrt/, rule);
  }
  assert.equal(customRuleProblem('Bash(npm install --ignore-scripts:*)'), null);
});

test('customRuleProblem: Geheimnisse, AIdeation selbst und übergeordnete Ordner', () => {
  for (const rule of [
    'Bash(cat .env)',
    'Bash(ls .ssh)',
    'Bash(make -C AIdeation)',
    'Bash(cat ../secret)',
    'Bash(x com.devlog)',
  ]) {
    assert.match(customRuleProblem(rule) ?? '', /Geheimnisse, AIdeation selbst/, rule);
  }
  assert.ok(CUSTOM_GROUP_ID.test('x-prisma'));
  assert.ok(!CUSTOM_GROUP_ID.test('X'));
});

test('loadProjectPermissions: gespeicherte Auswahl und eigene Gruppen; ohne Projekt alle Gruppen', async () => {
  const { pool, queries } = fakePool([
    [/agent_permissions/, [{ groups: ['git'] }]],
    [/project_permission_groups/, [prisma]],
  ]);
  assert.deepEqual(await loadProjectPermissions(pool, 'p'), { enabled: ['git'], custom: [prisma] });
  assert.deepEqual(
    queries.map((query) => query.values),
    [['p'], ['p']],
  );
  const empty = fakePool([]);
  assert.deepEqual(await loadProjectPermissions(empty.pool, 'p'), { enabled: null, custom: [] });
  const failing = { query: async () => Promise.reject(new Error('DB weg')) };
  await assert.rejects(loadProjectPermissions(failing, 'p'), /DB weg/, 'Datenbankfehler schlägt durch');
});

test('availableGroups und availableCommands: „files“ immer, eigene Gruppen immer, sonst nur freigeschaltete', () => {
  assert.equal(availableGroups(all).length, PERMISSION_GROUPS.length);
  const restricted: ProjectPermissions = { enabled: ['git'], custom: [prisma] };
  assert.deepEqual(
    availableGroups(restricted).map((group) => group.id),
    ['files', 'git', 'x-prisma'],
  );
  const commands = availableCommands(restricted);
  assert.ok(commands.has('files:create'));
  assert.ok(commands.has('Bash(git status:*)'));
  assert.ok(commands.has('Bash(npm run prisma:*)'));
  assert.ok(!commands.has('Bash(docker compose up:*)'));
  assert.deepEqual(
    DEFAULT_PERMISSION_GROUPS,
    PERMISSION_GROUPS.map((group) => group.id),
  );
});

test('roleDefaultCommands: lesende Rollen nichts, vertraute Rollen alles, übrige nur Dateien', () => {
  for (const role of ['visionary', 'analyst', 'pre_sprint']) {
    assert.ok(READ_ONLY_ROLES.has(role), role);
    assert.deepEqual(roleDefaultCommands(role, all), [], role);
  }
  for (const role of ['assistant', 'developer', 'tester', 'reviewer']) {
    assert.deepEqual(roleDefaultCommands(role, all), [...availableCommands(all)], role);
  }
  assert.deepEqual(roleDefaultCommands('documenter', all), ['files:create', 'files:edit']);
});

test('materializeAgentCommands: schreibt die Rollenstandards nur für Agents ohne Zuweisung', async () => {
  const { pool, queries } = fakePool([
    [
      /FROM agents/,
      [
        { id: 'a1', role: 'visionary' },
        { id: 'a2', role: 'documenter' },
      ],
    ],
    [/agent_permissions/, [{ groups: ['git'] }]],
  ]);
  await materializeAgentCommands(pool, 'p');
  const updates = queries.filter((query) => query.sql.startsWith('UPDATE agents'));
  assert.deepEqual(
    updates.map((query) => query.values),
    [
      ['a1', []],
      ['a2', ['files:create', 'files:edit']],
    ],
  );
  assert.ok(updates.every((query) => /allowed_commands IS NULL/.test(query.sql)));

  const none = fakePool([]);
  await materializeAgentCommands(none.pool, 'p');
  assert.equal(none.queries.length, 1, 'ohne Agents keine weiteren Abfragen');
});

test('guardHookCommand: startet den Wächter mit tsx-Loader und sperrt bei eigenem Fehler', () => {
  const hook = guardHookCommand({ create: true, edit: false, scopes: ['docs'] }) ?? '';
  assert.match(hook, /^'[^']*node[^']*' '--import' '[^']*tsx[^']*' '[^']*agent-guard\.ts' '[\w-]+' \|\| exit 2$/);
  assert.deepEqual(decodePolicy(/agent-guard\.ts' '([\w-]+)'/.exec(hook)?.[1]), {
    create: true,
    edit: false,
    scopes: ['docs'],
  });
});

test('hasFullAccess: nur der Assistent und nur mit ausdrücklicher Option', () => {
  assert.ok(FULL_ACCESS_ROLES.has('assistant'));
  assert.ok(hasFullAccess(['claude', '--dangerously-skip-permissions'], 'assistant'));
  assert.ok(hasFullAccess(['claude', '--permission-mode=bypassPermissions'], 'assistant'));
  assert.ok(hasFullAccess(['claude', '--permission-mode', 'bypassPermissions'], 'assistant'));
  assert.ok(!hasFullAccess(['claude', '--permission-mode', 'acceptEdits'], 'assistant'));
  assert.ok(!hasFullAccess(['claude', '--permission-mode'], 'assistant'));
  assert.ok(!hasFullAccess(['claude', '--dangerously-skip-permissions'], 'developer'));
});

test('withAgentPermissions: andere CLIs und leere Befehle bleiben unverändert', () => {
  assert.deepEqual(withAgentPermissions(['codex', 'exec'], 'developer', all, null), ['codex', 'exec']);
  assert.deepEqual(withAgentPermissions([], 'developer', all, null), []);
  // Auch mit Pfad wird die Claude-CLI erkannt.
  assert.ok(withAgentPermissions(['/usr/local/bin/claude', '-p'], 'developer', all, null).includes('--settings'));
});

test('withAgentPermissions: voller Zugriff des Assistenten ohne Wächter', () => {
  const full = ['claude', '--dangerously-skip-permissions', '-p'];
  assert.deepEqual(withAgentPermissions(full, 'assistant', all, ['files']), full);
});

test('withAgentPermissions: Visionär (nur lesen) ohne Datei-Werkzeuge und ohne Shell – trotz Zuweisung', () => {
  const command = withAgentPermissions(CLAUDE, 'visionary', all, ['files', 'Bash(git status:*)', 'logs']);
  assert.deepEqual(option(command, '--disallowedTools')?.split(','), [
    'Write',
    'Edit',
    'NotebookEdit',
    'MultiEdit',
    'Bash',
  ]);
  assert.equal(command.includes('--allowedTools'), false);
  assert.equal(command.includes('--add-dir'), false);
  assert.deepEqual(policyOf(command), { create: false, edit: false, shell: false, scopes: [] });
  // Auch eigene Werkzeug-Regeln im Befehl geben einer lesenden Rolle keine Rechte.
  const custom = withAgentPermissions(['claude', '--allowedTools', 'Bash', '-p'], 'pre_sprint', all, null);
  assert.match(option(custom, '--disallowedTools') ?? '', /Bash/);
  assert.deepEqual(policyOf(custom), { create: false, edit: false, shell: false, scopes: [] });
});

test('withAgentPermissions: eigene Werkzeug-Regeln im Befehl bleiben, der Wächter erlaubt Dateien', () => {
  const command = withAgentPermissions(['claude', '--disallowed-tools', 'WebFetch', '-p'], 'developer', all, []);
  assert.deepEqual(command.slice(-3), ['--disallowed-tools', 'WebFetch', '-p']);
  assert.equal(command.includes('--disallowedTools'), false, 'keine zusätzlichen Sperren');
  assert.equal(command.includes('--allowedTools'), false);
  assert.deepEqual(policyOf(command), { create: true, edit: true, scopes: [] });
});

test('withAgentPermissions: genau die zugewiesenen und im Projekt verfügbaren Befehle', () => {
  const restricted: ProjectPermissions = { enabled: ['git'], custom: [prisma] };
  const command = withAgentPermissions(
    CLAUDE,
    'developer',
    restricted,
    ['Bash(git status:*)', 'Bash(docker compose up:*)', 'Bash(npm run prisma:*)', 'files:edit'],
    ['src'],
  );
  assert.equal(option(command, '--allowedTools'), 'Bash(git status:*),Bash(npm run prisma:*)');
  assert.equal(option(command, '--disallowedTools'), 'Write');
  assert.deepEqual(policyOf(command), { create: false, edit: true, scopes: ['src'] });
  assert.deepEqual(command.slice(-2), ['-p', '{prompt}'], 'der ursprüngliche Befehl bleibt am Ende');
});

test('withAgentPermissions: Logs als zusätzlicher Ordner, Dienste mit Benutzer-ID', () => {
  const command = withAgentPermissions(CLAUDE, 'developer', all, ['logs', 'services', 'database'], [], ['/logs']);
  assert.equal(option(command, '--add-dir'), '/logs');
  assert.match(option(command, '--allowedTools') ?? '', /^Bash\(launchctl kickstart -k gui\/\d+\/ch\.\*\)$/);
  assert.equal(option(command, '--disallowedTools'), 'Write,Edit,NotebookEdit');
  // Ohne Logs-Recht kein zusätzlicher Ordner.
  assert.equal(withAgentPermissions(CLAUDE, 'developer', all, [], [], ['/logs']).includes('--add-dir'), false);
});

test('withAgentPermissions: Rollenstandard ohne Zuweisung (null), übrige Rollen nur Dateien', () => {
  const developer = withAgentPermissions(CLAUDE, 'developer', all, null);
  assert.ok((option(developer, '--allowedTools') ?? '').includes('Bash(npm test:*)'));
  assert.equal(developer.includes('--disallowedTools'), false);
  const documenter = withAgentPermissions(CLAUDE, 'documenter', all, null, ['docs']);
  assert.equal(documenter.includes('--allowedTools'), false);
  assert.deepEqual(policyOf(documenter), { create: true, edit: true, scopes: ['docs'] });
});

test('isAllowedCommand: npm-Optionen für fremde Projekte, Shells und Einstellungen sind gesperrt (auch abgekürzt)', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'npm-options-')));
  mkdirSync(join(root, 'docs'));
  symlinkSync(tmpdir(), join(root, 'raus'));
  for (const command of [
    'npm run build --prefix=/tmp/other',
    'npm run build --prefix=..',
    'npm run --prefix ../other build',
    'npm run --prefix raus build',
    'npm run build -C /tmp/other',
    'npm run build -sC /tmp/other',
    'npm run build --pref=/tmp/other',
    'npm run build --script-shell=/bin/sh',
    'npm run build --scr=/tmp/evil.sh',
    'npm test --userconfig=/tmp/npmrc',
    'npm test --globalconfig=/tmp/npmrc',
    'npm test --cache=/tmp/cache',
    'npm test --node-options=--require=/tmp/x.js',
    'npm test --location=global',
    'npm test -g',
    'npm test -L global',
  ]) {
    assert.ok(!isAllowedCommand(command, root), command);
    assert.ok(npmOptionProblem(command, root), command);
  }
  for (const command of ['npm run build', 'npm run --prefix docs build', 'npm run test:unit -- --watch=false']) {
    assert.ok(isAllowedCommand(command, root), command);
  }
  // Nach „--“ gehören die Argumente dem Skript (z. B. mocha -g).
  assert.equal(npmOptionProblem('npm test -- -g muster --cache', root), null);
  // Ohne Projektordner nur einfache relative Ordner.
  assert.ok(isAllowedCommand('npm run --prefix docs build'));
  assert.ok(!isAllowedCommand('npm run --prefix=../x build'));
  assert.ok(!isAllowedCommand('npm run --prefix=$HOME build'));
  assert.equal(npmOptionProblem('git diff --cache'), null, 'nur npm');
});
