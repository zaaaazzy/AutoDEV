import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import {
  BACKUP_DIRECTORY,
  MAX_FILE_BYTES,
  readProjectFile,
  resolveInside,
  SECRET_NAME,
  SKIPPED_DIRECTORIES,
  ToolError,
  walkText,
  writeProjectFile,
} from './tool-paths.js';

let root = '';
let outside = '';

before(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'tool-paths-')));
  outside = await realpath(await mkdtemp(join(tmpdir(), 'tool-paths-outside-')));
  await mkdir(join(root, 'src', 'deep'), { recursive: true });
  await writeFile(join(root, 'src', 'app.ts'), 'const needle = 1;\nkein Treffer\nneedle again\n');
  await writeFile(join(root, 'src', 'deep', 'b.md'), '# needle\n');
  await mkdir(join(root, 'node_modules', 'x'), { recursive: true });
  await writeFile(join(root, 'node_modules', 'x', 'index.js'), 'needle');
  await mkdir(join(root, BACKUP_DIRECTORY));
  await writeFile(join(root, BACKUP_DIRECTORY, 'old.ts'), 'needle');
  await writeFile(join(root, '.env'), 'needle=1');
  await writeFile(join(root, 'server.key'), 'needle');
  await writeFile(join(root, 'big.txt'), `needle\n${'x'.repeat(MAX_FILE_BYTES)}`);
  await writeFile(join(outside, 'secret.txt'), 'needle');
  await symlink(outside, join(root, 'escape'));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

const rejectsWith = (promise: Promise<unknown>, message: RegExp) =>
  assert.rejects(promise, (error: unknown) => error instanceof ToolError && message.test(error.message));

test('resolveInside: liefert den absoluten Pfad innerhalb des Projekts', async () => {
  assert.equal(await resolveInside(root, 'src/app.ts'), join(root, 'src', 'app.ts'));
  assert.equal(await resolveInside(root, '.'), root);
  assert.equal(await resolveInside(root, join(root, 'src')), join(root, 'src'), 'absolute Pfade im Projekt');
  assert.equal(await resolveInside(root, 'src/../src/app.ts'), join(root, 'src', 'app.ts'));
});

test('resolveInside: ungültige Angaben sind keine Pfade', async () => {
  for (const requested of [undefined, null, 42, '', 'a\0b', ['src']]) {
    await rejectsWith(resolveInside(root, requested), /Ungültiger Pfad/);
  }
});

test('resolveInside: nichts ausserhalb des Projekts, auch nicht über symbolische Links', async () => {
  await rejectsWith(resolveInside(root, '../etc/passwd'), /außerhalb/);
  await rejectsWith(resolveInside(root, '/etc/hosts'), /außerhalb/);
  await rejectsWith(resolveInside(root, 'escape/secret.txt'), /außerhalb/);
  // Auch nicht zum Anlegen einer neuen Datei hinter dem Link.
  await rejectsWith(resolveInside(root, 'escape/neu.txt', true), /außerhalb/);
});

test('writeProjectFile: ein nach der Prüfung gesetzter Link lenkt den Schreibvorgang nicht um', async () => {
  // Ordner: geprüft, solange es ihn nicht gibt; dann zeigt er als Link nach draussen.
  const intoFolder = await resolveInside(root, 'race/neu.txt', true);
  await symlink(outside, join(root, 'race'));
  await rejectsWith(writeProjectFile(root, intoFolder, 'umgelenkt'), /außerhalb/);
  assert.equal(existsSync(join(outside, 'neu.txt')), false);
  // Datei: geprüft als neue Datei, dann als Link auf eine Datei draussen angelegt.
  const intoFile = await resolveInside(root, 'race-file.txt', true);
  await symlink(join(outside, 'secret.txt'), intoFile);
  await rejectsWith(writeProjectFile(root, intoFile, 'überschrieben'), /außerhalb/);
  assert.equal(await readFile(join(outside, 'secret.txt'), 'utf8'), 'needle');
  // Geschützter Ordner hinter einem Link im Projekt.
  await symlink(join(root, BACKUP_DIRECTORY), join(root, 'to-backup'));
  await rejectsWith(writeProjectFile(root, join(root, 'to-backup', 'old.ts'), 'x'), /nicht erlaubt/);
  assert.equal(await readFile(join(root, BACKUP_DIRECTORY, 'old.ts'), 'utf8'), 'needle');
});

test('writeProjectFile: legt Ordner an, behält Rechte und Links im Projekt, hinterlässt keine Temp-Datei', async () => {
  const fresh = join(root, 'neu', 'tief', 'c.txt');
  assert.equal(await writeProjectFile(root, fresh, 'hallo'), fresh);
  assert.equal(await readFile(fresh, 'utf8'), 'hallo');
  const script = join(root, 'run.sh');
  await writeFile(script, 'echo alt\n');
  await chmod(script, 0o755);
  await writeProjectFile(root, script, 'echo neu\n');
  assert.equal((await stat(script)).mode & 0o777, 0o755);
  // Ein Link im Projekt bleibt Link; geschrieben wird sein Ziel.
  await symlink(join(root, 'src', 'deep', 'b.md'), join(root, 'link.md'));
  assert.equal(await writeProjectFile(root, join(root, 'link.md'), '# neu\n'), join(root, 'src', 'deep', 'b.md'));
  assert.equal((await lstat(join(root, 'link.md'))).isSymbolicLink(), true);
  assert.equal(await readFile(join(root, 'src', 'deep', 'b.md'), 'utf8'), '# neu\n');
  for (const directory of [root, join(root, 'neu', 'tief'), join(root, 'src', 'deep')]) {
    assert.deepEqual(
      (await readdir(directory)).filter((name) => name.endsWith('.tmp')),
      [],
    );
  }
  await writeFile(join(root, 'src', 'deep', 'b.md'), '# needle\n');
});

test('resolveInside: Git, Abhängigkeiten, Sicherungen und Geheimnisse sind gesperrt', async () => {
  for (const path of [
    '.git/config',
    '.GIT/HEAD',
    'node_modules/x/index.js',
    'Node_Modules/x',
    `${BACKUP_DIRECTORY}/old.ts`,
    `${BACKUP_DIRECTORY.toUpperCase()}/old.ts`,
    '.env',
    'src/.env.local',
    'server.key',
    'certs/tls.pem',
    'id_rsa',
    'home/id_ed25519.pub',
  ]) {
    await rejectsWith(resolveInside(root, path, true), /nicht erlaubt/);
  }
});

test('resolveInside: gesperrte Namen gelten auch am Ziel symbolischer Links', async () => {
  await mkdir(join(root, '.git', 'hooks'), { recursive: true });
  await writeFile(join(root, '.git', 'config'), '[core]');
  await symlink('.env', join(root, 'notes.txt'));
  await symlink('.git/hooks/pre-commit', join(root, 'hook'));
  await symlink('.git', join(root, 'gitdir'));
  await symlink('node_modules/x', join(root, 'dep'));
  await symlink('fehlt/nirgends.txt', join(root, 'dangling.txt'));
  await rejectsWith(resolveInside(root, 'notes.txt'), /nicht erlaubt/);
  await rejectsWith(resolveInside(root, 'notes.txt', true), /nicht erlaubt/);
  // Ziel existiert (noch) nicht: der Link selbst darf nicht beschrieben werden.
  await rejectsWith(resolveInside(root, 'hook', true), /nicht erlaubt/);
  await rejectsWith(resolveInside(root, 'dangling.txt', true), /nicht erlaubt/);
  await rejectsWith(resolveInside(root, 'gitdir/hooks/pre-commit', true), /nicht erlaubt/);
  await rejectsWith(resolveInside(root, 'gitdir/config'), /nicht erlaubt/);
  await rejectsWith(resolveInside(root, 'dep/index.js'), /nicht erlaubt/);
  // Harmlose Links im Projekt bleiben nutzbar.
  await symlink('src', join(root, 'quellen'));
  assert.equal(await resolveInside(root, 'quellen/app.ts'), join(root, 'quellen', 'app.ts'));
  assert.equal(await resolveInside(root, 'quellen/neu.ts', true), join(root, 'quellen', 'neu.ts'));
});

test('resolveInside: Lesen verlangt eine vorhandene Datei, Schreiben nur einen Ordner im Projekt', async () => {
  await rejectsWith(resolveInside(root, 'fehlt.txt'), /existiert nicht/);
  assert.equal(await resolveInside(root, 'neu/tief/datei.txt', true), join(root, 'neu', 'tief', 'datei.txt'));
});

test('walkText: findet Treffer mit Datei und Zeile, überspringt gesperrte, geheime und grosse Dateien', async () => {
  const matches: string[] = [];
  await walkText(root, root, 'needle', matches);
  assert.deepEqual(matches.sort(), [
    'src/app.ts:1: const needle = 1;',
    'src/app.ts:3: needle again',
    'src/deep/b.md:1: # needle',
  ]);
  // Unterordner als Start, Pfade bleiben relativ zum Projekt.
  const deep: string[] = [];
  await walkText(join(root, 'src', 'deep'), root, 'needle', deep);
  assert.deepEqual(deep, ['src/deep/b.md:1: # needle']);
  const none: string[] = [];
  await walkText(root, root, 'gibt es nicht', none);
  assert.deepEqual(none, []);
});

test('walkText: höchstens 50 Treffer, lange Zeilen gekürzt', async () => {
  const many = await realpath(await mkdtemp(join(tmpdir(), 'tool-paths-many-')));
  try {
    await writeFile(join(many, 'a.txt'), Array.from({ length: 40 }, () => `  treffer ${'y'.repeat(300)}`).join('\n'));
    await writeFile(join(many, 'b.txt'), Array.from({ length: 40 }, () => 'treffer').join('\n'));
    await writeFile(join(many, 'c.txt'), 'treffer');
    const matches: string[] = [];
    await walkText(many, many, 'treffer', matches);
    assert.equal(matches.length, 50);
    assert.ok(matches.every((match) => !match.endsWith('y'.repeat(300))));
    const first = matches.find((match) => match.startsWith('a.txt:1: '));
    assert.match(first ?? '', /^a\.txt:1: treffer y+$/);
    assert.equal(first?.length, 'a.txt:1: '.length + 200);
  } finally {
    await rm(many, { recursive: true, force: true });
  }
});

test('Konstanten: übersprungene Ordner und Geheimnis-Muster', () => {
  for (const name of ['node_modules', '.git', 'dist', BACKUP_DIRECTORY, 'coverage']) {
    assert.ok(SKIPPED_DIRECTORIES.has(name), name);
  }
  for (const name of [
    '.env',
    '.env.production',
    'a.pem',
    'b.KEY',
    'id_ecdsa',
    '.npmrc',
    '.netrc',
    '.git-credentials',
  ]) {
    assert.ok(SECRET_NAME.test(name), name);
  }
  for (const name of ['env.ts', 'keys.ts', 'readme.md', 'npmrc.md', '.npmrc.md', 'keyboard.ts']) {
    assert.ok(!SECRET_NAME.test(name), name);
  }
});

test('readProjectFile: liest Dateien im Projekt, folgt aber keinen Links', async () => {
  const root = await mkdtemp(join(tmpdir(), 'project-file-'));
  const outside = await mkdtemp(join(tmpdir(), 'project-file-outside-'));
  await writeFile(join(outside, 'geheim'), 'GEHEIM');
  await mkdir(join(root, 'docs'));
  await writeFile(join(root, 'docs', 'a.md'), 'Doku');
  await symlink(join(outside, 'geheim'), join(root, 'link.md'));
  await symlink(join(root, 'docs', 'a.md'), join(root, 'intern.md'));
  await symlink(outside, join(root, 'raus'));
  await symlink(join(outside, 'fehlt'), join(root, 'leer.md'));
  assert.equal((await readProjectFile(root, 'docs/a.md'))?.content.toString(), 'Doku');
  assert.equal((await readProjectFile(root, join(root, 'docs/a.md')))?.content.toString(), 'Doku');
  for (const path of [
    'link.md',
    'intern.md',
    'raus/geheim',
    'leer.md',
    '../x',
    'docs',
    'fehlt.md',
    join(outside, 'geheim'),
  ]) {
    assert.equal(await readProjectFile(root, path), null, path);
  }
  assert.equal(await readProjectFile(root, 'docs/a.md', 3), null, 'zu gross');
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});
