import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { adminDatabaseUrl, localDatabaseUrl, mainWorktreeRoot, readEnvValues } from './local-database.js';

test('Lokale Datenbank: Passwort aus der .env statt Standardpasswort, Sonderzeichen kodiert', async () => {
  const root = await mkdtemp(join(tmpdir(), 'local-database-'));
  try {
    assert.equal(
      localDatabaseUrl(readEnvValues(root)),
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
