import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { forbiddenCommand, forbiddenSubcommand, gitFileProblem, type FileRights } from './command-checks.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'git-file-')));
after(() => rmSync(root, { recursive: true, force: true }));
mkdirSync(join(root, 'migrations'));
writeFileSync(join(root, 'migrations', '009_a.sql'), 'x');
writeFileSync(join(root, 'migrations', '010_a.sql'), 'x');
mkdirSync(join(root, 'paket', '.githooks'), { recursive: true });
symlinkSync(tmpdir(), join(root, 'raus'));
const all: FileRights = { create: true, edit: true, scopes: [] };

test('gitFileProblem: git rm und git mv auf einfache Pfade im Projekt sind erlaubt', () => {
  for (const command of [
    'git rm migrations/009_a.sql',
    'git rm -q migrations/009_a.sql migrations/010_a.sql',
    'git rm --quiet --cached -- migrations/009_a.sql',
    'git rm -n -r migrations',
    'git mv migrations/009_a.sql migrations/011_a.sql',
    'git mv -n -v migrations/009_a.sql migrations/010_a.sql migrations',
    'git mv ./migrations/009_a.sql migrations/neu/',
  ]) {
    assert.equal(gitFileProblem(command, root, all), null, command);
  }
  // Andere Befehle prüft gitFileProblem nicht.
  assert.equal(gitFileProblem('git status', root, all), null);
});

test('gitFileProblem: gefährliche Optionen sind gesperrt – auch abgekürzt oder zusammengefasst', () => {
  for (const command of [
    'git rm -f migrations/009_a.sql',
    'git rm --force migrations/009_a.sql',
    'git rm --forc migrations/009_a.sql',
    'git rm -rf migrations',
    'git rm -fr migrations',
    'git rm -rq migrations',
    'git rm --pathspec-from-file=liste.txt',
    'git rm --pathspec-from-file liste.txt',
    'git rm --pathspec-f=liste.txt',
    'git rm --pathspec-file-nul --pathspec-from-file=-',
    'git rm --ignore-unmatch x',
    'git rm --sparse migrations/009_a.sql',
    'git rm --cach migrations/009_a.sql',
    'git mv -f migrations/009_a.sql migrations/010_a.sql',
    'git mv --force migrations/009_a.sql migrations/010_a.sql',
    'git mv -k migrations/009_a.sql x',
    'git mv -r migrations x',
    'git mv --verb migrations/009_a.sql x',
  ]) {
    assert.match(gitFileProblem(command, root, all) ?? '', /Option/, command);
  }
});

test('gitFileProblem: Pfade ausserhalb, geschützt, Pathspec-Magie und Shell-Erweiterungen sind gesperrt', () => {
  for (const command of [
    'git rm ../x',
    'git rm migrations/../../x',
    'git rm /etc/hosts',
    'git rm raus/x',
    'git rm raus',
    'git rm .env',
    'git rm config/.env.production',
    'git rm .git/config',
    'git rm -r .git',
    'git rm .GIT/config',
    'git rm .claude/settings.json',
    'git rm .mcp.json',
    'git rm .npmrc',
    'git rm node_modules/x/index.js',
    'git rm -r .',
    'git rm -r ./',
    'git rm -r migrations/..',
    'git rm -r paket',
    'git mv migrations/009_a.sql .env',
    'git mv migrations/009_a.sql .git/hooks/pre-commit',
    'git mv migrations/009_a.sql .husky/pre-commit',
    'git mv migrations/009_a.sql .npmrc',
    'git mv migrations/009_a.sql ../009_a.sql',
    'git mv migrations/009_a.sql /tmp/009_a.sql',
    'git mv migrations/009_a.sql raus/009_a.sql',
    'git mv migrations/009_a.sql .',
    'git mv .env x',
    "git rm ':(top)x'",
    "git rm ':(glob)**/*.sql'",
    "git rm ':!docs'",
    "git rm ':/x'",
    "git rm 'migrations/*.sql'",
    'git rm migrations/*.sql',
    "git rm 'migrations/00?_a.sql'",
    "git rm 'migrations/[0-9]*'",
    "git rm 'migrations\\009_a.sql'",
    'git rm $X',
    'git rm "$X"',
    'git rm ~/x',
    'git rm {a,b}',
    "git rm $'x'",
    'git rm',
    'git rm -q',
    'git mv migrations/009_a.sql',
  ]) {
    assert.ok(gitFileProblem(command, root, all), command);
  }
});

test('gitFileProblem: Rechte und Ordner-Einschränkung', () => {
  const editOnly = { create: false, edit: true, scopes: [] };
  assert.equal(gitFileProblem('git rm migrations/009_a.sql', root, editOnly), null);
  assert.match(gitFileProblem('git mv migrations/009_a.sql x.sql', root, editOnly) ?? '', /Dateien anlegen/);
  const createOnly = { create: true, edit: false, scopes: [] };
  assert.match(gitFileProblem('git rm migrations/009_a.sql', root, createOnly) ?? '', /Dateien ändern/);
  assert.match(gitFileProblem('git mv migrations/009_a.sql x.sql', root, createOnly) ?? '', /Dateien ändern/);
  // Ohne Richtlinie (lokales Modell ohne Rechte-Kontext) ist beides gesperrt.
  assert.ok(gitFileProblem('git rm migrations/009_a.sql', root));
  assert.ok(gitFileProblem('git mv migrations/009_a.sql x.sql', root));
  const scoped = { create: true, edit: true, scopes: ['migrations'] };
  assert.equal(gitFileProblem('git mv migrations/009_a.sql migrations/011_a.sql', root, scoped), null);
  assert.match(gitFileProblem('git rm paket/x', root, scoped) ?? '', /erlaubten Ordner/);
  assert.match(gitFileProblem('git mv migrations/009_a.sql paket/x.sql', root, scoped) ?? '', /erlaubten Ordner/);
  assert.match(gitFileProblem('git mv paket/x.sql migrations/x.sql', root, scoped) ?? '', /erlaubten Ordner/);
  assert.match(gitFileProblem('git rm -r migrations/..', root, scoped) ?? '', /einfache relative Pfade/);
});

test('git rm/mv: Optionen vor dem Unterbefehl, versteckte Unterbefehle und rm, mv, cp bleiben gesperrt', () => {
  for (const command of [
    'git -C .. rm x',
    'git --git-dir=.git rm x',
    'git --work-tree=/ rm x',
    'git -c core.x=y mv a b',
    'git "rm" x',
    "git 'mv' a b",
    'git r\\m x',
    'git m\\v a b',
    'git $X x',
    'git r? x',
    'git {rm,} x',
  ]) {
    assert.ok(forbiddenSubcommand(command), command);
  }
  for (const command of ['rm x', 'mv a b', 'cp a b', '/bin/rm x', '"mv" a b', '\\cp a b', 'command git rm x']) {
    assert.ok(forbiddenCommand(command), command);
  }
});
