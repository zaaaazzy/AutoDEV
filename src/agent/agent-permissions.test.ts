import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commandLabel, customRuleProblem, type ProjectPermissions, withAgentPermissions } from './tool-permissions.js';

const CLAUDE = ['claude', '--permission-mode', 'acceptEdits', '-p', '{prompt}'];
const project: ProjectPermissions = {
  enabled: null,
  custom: [{ id: 'x-prisma', label: 'Prisma', description: '', rules: ['Bash(npm run prisma:*)'] }],
};
const option = (command: string[], flag: string): string | undefined =>
  command.includes(flag) ? command[command.indexOf(flag) + 1] : undefined;

test('Eigene Befehle: sichere ja, gesperrte und Shell-Tricks nein', () => {
  assert.equal(customRuleProblem('Bash(npm run lint:*)'), null);
  assert.equal(customRuleProblem('Bash(make test)'), null);
  assert.equal(customRuleProblem('WebFetch(domain:localhost)'), null);
  for (const bad of [
    'Bash(rm -rf:*)',
    'Bash(sudo:*)',
    'Bash(git push:*)',
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
  ]) {
    assert.ok(customRuleProblem(bad), bad);
  }
});

test('Agent bekommt genau die einzeln gesetzten Befehle, ohne „Dateien“ keine Datei-Werkzeuge', () => {
  const reviewer = withAgentPermissions(CLAUDE, 'reviewer', project, ['Bash(git status:*)', 'Bash(git diff:*)']);
  assert.equal(option(reviewer, '--allowedTools'), 'Bash(git status:*),Bash(git diff:*)');
  assert.equal(option(reviewer, '--disallowedTools'), 'Edit,Write,MultiEdit,NotebookEdit');
  const developer = withAgentPermissions(CLAUDE, 'developer', project, ['files', 'logs', 'Bash(npm run prisma:*)']);
  assert.equal(option(developer, '--allowedTools'), 'Bash(npm run prisma:*)');
  assert.ok(developer.includes('--add-dir'));
  assert.equal(developer.includes('--disallowedTools'), false);
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

test('Ohne Zuweisung bisheriges Verhalten: nur vertraute Rollen bekommen Projektrechte', () => {
  assert.deepEqual(withAgentPermissions(CLAUDE, 'author', project, null), CLAUDE);
  assert.ok(withAgentPermissions(CLAUDE, 'developer', project, null).includes('--allowedTools'));
});

test('Lesbare Bezeichnungen der Befehle', () => {
  assert.equal(commandLabel('Bash(git status:*)'), 'git status …');
  assert.equal(commandLabel('Bash(make test)'), 'make test');
  assert.equal(commandLabel('files'), 'Dateien erstellen und ändern');
  assert.equal(commandLabel('WebFetch(domain:localhost)'), 'Webseiten auf localhost abrufen');
});
