import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  commandHelp,
  commandLabel,
  customRuleProblem,
  normalizeCommands,
  PERMISSION_GROUPS,
  type ProjectPermissions,
  rulesAllow,
  hasFullAccess,
  withAgentPermissions,
} from './tool-permissions.js';
import { decodePolicy } from './agent-guard.js';

const CLAUDE = ['claude', '--permission-mode', 'acceptEdits', '-p', '{prompt}'];
const project: ProjectPermissions = {
  enabled: null,
  custom: [{ id: 'x-prisma', label: 'Prisma', description: '', rules: ['Bash(npm run prisma:*)'] }],
};
const option = (command: string[], flag: string): string | undefined =>
  command.includes(flag) ? command[command.indexOf(flag) + 1] : undefined;
/** Richtlinie, die der Wächter-Hook in --settings bekommt. */
const policyOf = (command: string[]) => {
  const settings = JSON.parse(option(command, '--settings') ?? '{}') as {
    hooks: { PreToolUse: { matcher: string; hooks: { command: string }[] }[] };
  };
  const hook = settings.hooks.PreToolUse[0]!;
  assert.match(hook.matcher, /Write/);
  assert.match(hook.matcher, /Bash/);
  assert.match(hook.hooks[0]!.command, /agent-guard\.ts' '([\w-]+)' \|\| exit 2$/);
  return decodePolicy(/agent-guard\.ts' '([\w-]+)'/.exec(hook.hooks[0]!.command)![1]);
};

interface CliSettings {
  permissions?: { deny?: string[] };
  hooks?: { PreToolUse: { matcher: string; hooks: { command: string }[] }[] };
}
const settingsOf = (command: string[]): CliSettings => JSON.parse(option(command, '--settings') ?? '{}') as CliSettings;

test('Geheimnisse: jede Rolle bekommt Deny-Regeln und den Wächter für Read, Grep und Glob', () => {
  const roles = [
    'author',
    'developer',
    'tester',
    'visual_tester',
    'reviewer',
    'documenter',
    'bug_reviewer',
    'manual_writer',
    'user_manual_writer',
    'custom',
    'assistant',
    'routine',
    'visionary',
    'analyst',
    'pre_sprint',
  ];
  const full = ['claude', '--dangerously-skip-permissions', '-p', '{prompt}'];
  const custom = ['claude', '--allowedTools', 'Read', '-p', '{prompt}'];
  for (const role of roles) {
    for (const base of [CLAUDE, full, custom]) {
      const command = withAgentPermissions(base, role, project, null);
      const label = `${role}: ${base.join(' ')}`;
      const settings = settingsOf(command);
      const deny = settings.permissions?.deny ?? [];
      // .env, config/.env.production, certs/server.key, *.pem und SSH-Schlüssel
      for (const rule of ['Read(**/.env*)', 'Read(**/*.key)', 'Read(**/*.pem)', 'Read(**/.ssh/**)']) {
        assert.ok(deny.includes(rule), `${label} ohne ${rule}`);
      }
      const matcher = settings.hooks?.PreToolUse[0]?.matcher ?? '';
      for (const tool of ['Read', 'Grep', 'Glob']) assert.ok(matcher.split('|').includes(tool), `${label}: ${tool}`);
    }
  }
});

test('Eigene Befehle: sichere ja, gesperrte und Shell-Tricks nein', () => {
  assert.equal(customRuleProblem('Bash(npm run lint:*)'), null);
  assert.equal(customRuleProblem('Bash(make test)'), null);
  assert.equal(customRuleProblem('WebFetch(domain:localhost)'), null);
  for (const bad of [
    'Bash(rm -rf:*)',
    'Bash(sudo:*)',
    'Bash(git push:*)',
    'Bash(git clone:*)',
    'Bash(npm --prefix . exec:*)',
    'Bash(curl:*)',
    'Bash(npm run x; rm -rf /)',
    'Bash(cat ../secret)',
    'Bash(cat .env)',
    'Bash(launchctl kickstart -k gui/501/com.devlog.worker)',
    'Bash(bash -c x)',
    'Bash(npm install left-pad)',
    'WebFetch(domain:example.com)',
    'Read(/etc/passwd)',
    'files',
    'files:create',
  ]) {
    assert.ok(customRuleProblem(bad), bad);
  }
});

test('Agent bekommt genau die einzeln gesetzten Befehle; Datei-Werkzeuge nur mit Anlegen bzw. Ändern', () => {
  const reviewer = withAgentPermissions(CLAUDE, 'reviewer', project, ['Bash(git status:*)', 'Bash(git diff:*)']);
  assert.equal(option(reviewer, '--allowedTools'), 'Bash(git status:*),Bash(git diff:*)');
  assert.equal(option(reviewer, '--disallowedTools'), 'Write,Edit,NotebookEdit');
  assert.deepEqual(policyOf(reviewer), { create: false, edit: false, scopes: [] });

  const writer = withAgentPermissions(CLAUDE, 'documenter', project, ['files:create'], ['docs']);
  assert.equal(option(writer, '--disallowedTools'), 'Edit,NotebookEdit');
  assert.deepEqual(policyOf(writer), { create: true, edit: false, scopes: ['docs'] });

  const developer = withAgentPermissions(CLAUDE, 'developer', project, ['files', 'logs', 'Bash(npm run prisma:*)']);
  assert.equal(option(developer, '--allowedTools'), 'Bash(npm run prisma:*)');
  assert.ok(developer.includes('--add-dir'));
  assert.equal(developer.includes('--disallowedTools'), false);
  assert.deepEqual(policyOf(developer), { create: true, edit: true, scopes: [] });
});

test('Befehle anderer Projekte oder ausgeschalteter Kategorien wirken nicht', () => {
  const restricted: ProjectPermissions = { enabled: ['git'], custom: [] };
  const agent = withAgentPermissions(CLAUDE, 'developer', restricted, [
    'Bash(git status:*)',
    'Bash(docker compose up:*)',
    'Bash(npm run prisma:*)',
  ]);
  assert.equal(option(agent, '--allowedTools'), 'Bash(git status:*)');
});

test('Ohne Zuweisung gelten die Rollenstandards – auch dann mit Wächter', () => {
  const author = withAgentPermissions(CLAUDE, 'author', project, null);
  assert.equal(author.includes('--allowedTools'), false);
  assert.deepEqual(policyOf(author), { create: true, edit: true, scopes: [] });
  assert.ok(withAgentPermissions(CLAUDE, 'developer', project, null).includes('--allowedTools'));
  // Andere CLIs bleiben unverändert; eigene Werkzeug-Regeln im Befehl bleiben, der Wächter kommt dazu.
  assert.deepEqual(withAgentPermissions(['copilot', '-p'], 'developer', project, null), ['copilot', '-p']);
  const explicit = withAgentPermissions(['claude', '--allowedTools', 'Read', '-p'], 'developer', project, []);
  assert.equal(option(explicit, '--allowedTools'), 'Read');
  assert.ok(explicit.includes('--settings'));
});

test('Freigaben verwenden keine Befehle, die beliebigen Code laden oder ausserhalb schreiben', () => {
  const rules = PERMISSION_GROUPS.flatMap((group) => group.rules);
  for (const rule of rules) {
    assert.ok(!/npm --prefix|git clone|npx (?!--no-install)|git push|rm |sudo|kill|com\.devlog|curl/.test(rule), rule);
  }
  assert.ok(rules.includes('Bash(npx --no-install tsc:*)'));
});

test('Bezeichnungen ohne „…“, jede eingebaute Freigabe mit eigener Erklärung', () => {
  assert.equal(commandLabel('Bash(git status:*)'), 'git status');
  assert.equal(commandLabel('Bash(make test)'), 'make test');
  assert.equal(commandLabel('files:create'), 'Dateien anlegen');
  assert.equal(commandLabel('files:edit'), 'Dateien ändern');
  assert.equal(commandLabel('WebFetch(domain:localhost)'), 'Webseiten auf localhost abrufen');
  for (const rule of PERMISSION_GROUPS.flatMap((group) => group.rules)) {
    assert.notEqual(commandHelp(rule), rule, rule);
    assert.doesNotMatch(commandHelp(rule), /^Führt „/, rule);
  }
  assert.equal(commandHelp('Bash(make test:*)'), 'Führt „make test“ aus, auch mit weiteren Argumenten.');
  assert.deepEqual(normalizeCommands(['files', 'files:edit', 'logs']), ['files:create', 'files:edit', 'logs']);
});

test('Lokales Modell: Shell-Befehle nur innerhalb der Freigaben des Agents', () => {
  const rules = ['Bash(git status:*)', 'Bash(node --version)'];
  assert.ok(rulesAllow(rules, 'git status'));
  assert.ok(rulesAllow(rules, 'git status --short'));
  assert.ok(!rulesAllow(rules, 'git statusx'));
  assert.ok(!rulesAllow(rules, 'git diff'));
  assert.ok(rulesAllow(rules, 'node --version'));
  assert.ok(!rulesAllow(rules, 'node --version --x'));
  assert.ok(PERMISSION_GROUPS.some((group) => group.rules.includes('database')));
});

test('Dienste-Freigabe wird erst beim Start mit der Benutzer-ID aufgelöst', () => {
  assert.deepEqual(normalizeCommands(['Bash(launchctl kickstart -k gui/1000/ch.*)']), ['services']);
  const agent = withAgentPermissions(CLAUDE, 'developer', project, ['services']);
  assert.match(option(agent, '--allowedTools') ?? '', /^Bash\(launchctl kickstart -k gui\/\d+\/ch\.\*\)$/);
  assert.equal(commandLabel('services'), 'launchctl kickstart -k ch.*');
});

test('voller Zugriff ohne Wächter nur für den Dashboard-Assistenten und nur auf ausdrücklichen Wunsch', () => {
  const full = ['claude', '--model', 'sonnet', '--dangerously-skip-permissions', '-p', '{prompt}'];
  // Nur die Sperre für Geheimnisse kommt dazu (siehe unten), sonst bleibt der Befehl, wie er ist.
  const withoutSettings = (command: string[]) => command.filter((_, i) => i !== 1 && i !== 2);
  const fullCommand = withAgentPermissions(full, 'assistant', project, null);
  assert.deepEqual(withoutSettings(fullCommand), full);
  assert.ok(!fullCommand.includes('--allowedTools') && !fullCommand.includes('--disallowedTools'));
  assert.doesNotMatch(settingsOf(fullCommand).hooks!.PreToolUse[0]!.matcher, /Write|Bash/);
  const bypass = ['claude', '--permission-mode', 'bypassPermissions', '-p', '{prompt}'];
  assert.deepEqual(withoutSettings(withAgentPermissions(bypass, 'assistant', project, null)), bypass);
  assert.ok(hasFullAccess(['claude', '--permission-mode=bypassPermissions'], 'assistant'));
  // Andere Rollen behalten Wächter und Regeln, auch wenn der Befehl dasselbe verlangt.
  const developer = withAgentPermissions(full, 'developer', project, null);
  assert.ok(developer.includes('--settings'));
  assert.ok(developer.includes('--allowedTools'));
  assert.ok(!hasFullAccess(full, 'developer'));
  // Ohne die Option bleibt auch der Assistent beim Wächter.
  assert.ok(withAgentPermissions(CLAUDE, 'assistant', project, null).includes('--settings'));
});

test('Routinen: Shell unter dem Wächter, aber keine Datei-Werkzeuge und nie Vollzugriff', () => {
  const full = ['claude', '--dangerously-skip-permissions', '-p', '{prompt}'];
  for (const base of [CLAUDE, full]) {
    const command = withAgentPermissions(base, 'routine', project, null);
    const disallowed = (option(command, '--disallowedTools') ?? '').split(',');
    for (const tool of ['Write', 'Edit']) assert.ok(disallowed.includes(tool), tool);
    assert.ok(!disallowed.includes('Bash'), 'Shell bleibt (z. B. npm audit)');
    const policy = policyOf(command);
    assert.equal(policy.create, false);
    assert.equal(policy.edit, false);
  }
  assert.ok(!hasFullAccess(full, 'routine'));
  // Auch eine Zuweisung „Dateien ändern“ am Agent gibt einer Routine keine Schreibrechte.
  const assigned = withAgentPermissions(CLAUDE, 'routine', project, ['files:create', 'files:edit']);
  assert.equal(policyOf(assigned).edit, false);
});

test('die Problemanalyse (analyst) arbeitet nur lesend: keine Datei-Werkzeuge, keine Shell', () => {
  const command = withAgentPermissions(CLAUDE, 'analyst', project, null);
  const disallowed = command[command.indexOf('--disallowedTools') + 1] ?? '';
  for (const tool of ['Write', 'Edit', 'Bash']) assert.ok(disallowed.split(',').includes(tool), tool);
  assert.ok(!command.includes('--allowedTools'));
});
