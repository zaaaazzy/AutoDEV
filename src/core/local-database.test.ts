import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  adminDatabaseUrl,
  loadInstallEnv,
  localDatabaseUrl,
  mainWorktreeRoot,
  readEnvValues,
  requireDatabaseUrl,
} from './local-database.js';

test('Lokale Datenbank: Passwort aus der .env statt Standardpasswort, Sonderzeichen kodiert', async () => {
  const root = await mkdtemp(join(tmpdir(), 'local-database-'));
  try {
    // Ohne .env kein stiller Rückfall auf das Standardpasswort, sondern ein Abbruch mit Hinweis.
    assert.throws(
      () => localDatabaseUrl(readEnvValues(root), 'aideation', '127.0.0.1', {}),
      /DEV_LOG_DB_PASSWORD fehlt/,
    );
    assert.equal(
      localDatabaseUrl(readEnvValues(root), 'aideation', '127.0.0.1', { DEV_LOG_ALLOW_DEFAULT_DB_PASSWORD: '1' }),
      'postgresql://devlog:devlog_local_dev@127.0.0.1:5433/aideation',
    );
    await writeFile(join(root, '.env'), "DEV_LOG_DB_USER=anna\nDEV_LOG_DB_PASSWORD='p@ss:w/rd'\n");
    const url = localDatabaseUrl(readEnvValues(root));
    assert.equal(url, 'postgresql://anna:p%40ss%3Aw%2Frd@127.0.0.1:5433/aideation');
    assert.equal(decodeURIComponent(new URL(url).password), 'p@ss:w/rd');
    assert.equal(adminDatabaseUrl(url), 'postgresql://anna:p%40ss%3Aw%2Frd@127.0.0.1:5433/postgres');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Git-Worktree ohne eigene .env (Agent-Ordner): Zugang aus der .env des Hauptordners', async () => {
  const base = await mkdtemp(join(tmpdir(), 'local-database-wt-'));
  const main = join(base, 'source');
  const worktree = join(base, 'agent');
  try {
    await mkdir(join(main, '.git', 'worktrees', 'agent'), { recursive: true });
    await mkdir(worktree);
    await writeFile(join(main, '.env'), 'DEV_LOG_DB_PASSWORD=aus-dem-hauptordner\n');
    await writeFile(join(worktree, '.git'), `gitdir: ${join(main, '.git', 'worktrees', 'agent')}\n`);
    assert.equal(mainWorktreeRoot(worktree), main);
    assert.equal(mainWorktreeRoot(main), null, 'Hauptordner selbst hat einen .git-Ordner');
    assert.equal(readEnvValues(worktree).get('DEV_LOG_DB_PASSWORD'), 'aus-dem-hauptordner');
    // Eine eigene .env im Worktree geht vor.
    await writeFile(join(worktree, '.env'), 'DEV_LOG_DB_PASSWORD=eigene\n');
    assert.equal(readEnvValues(worktree).get('DEV_LOG_DB_PASSWORD'), 'eigene');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('Worker und Wächter: Zugang aus der .env, die Umgebung hat Vorrang, ohne URL ein klarer Abbruch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'local-database-load-'));
  try {
    // Ohne .env und ohne Variable: kein Standardwert, sondern ein Abbruch mit Hinweis auf die Einrichtung.
    const empty: NodeJS.ProcessEnv = {};
    assert.deepEqual(loadInstallEnv(root, empty), []);
    assert.throws(() => requireDatabaseUrl(empty), /DEV_LOG_DATABASE_URL fehlt.*start\.sh --setup/);
    assert.throws(() => requireDatabaseUrl({ DEV_LOG_DATABASE_URL: '  ' }), /DEV_LOG_DATABASE_URL fehlt/);

    await writeFile(
      join(root, '.env'),
      [
        "DEV_LOG_DATABASE_URL='postgresql://devlog:zuf%C3%A4llig@localhost:5433/aideation'",
        'export DEV_LOG_SECRET_KEY=schluessel # Kommentar',
        'DEV_LOG_PASSWORD=oberflaeche',
        'DEV_LOG_PUBLIC_URL=https://alt.example.ch',
      ].join('\n'),
    );
    const environment: NodeJS.ProcessEnv = { DEV_LOG_PUBLIC_URL: 'https://aus-der-umgebung.example.ch' };
    assert.deepEqual(loadInstallEnv(root, environment), ['DEV_LOG_DATABASE_URL', 'DEV_LOG_SECRET_KEY']);
    assert.equal(requireDatabaseUrl(environment), 'postgresql://devlog:zuf%C3%A4llig@localhost:5433/aideation');
    assert.equal(environment.DEV_LOG_SECRET_KEY, 'schluessel');
    // Gesetzte Werte bleiben; Anmeldedaten der Oberfläche gelangen nicht in die Umgebung der Agents.
    assert.equal(environment.DEV_LOG_PUBLIC_URL, 'https://aus-der-umgebung.example.ch');
    assert.equal(environment.DEV_LOG_PASSWORD, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
