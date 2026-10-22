import assert from 'node:assert/strict';
import { mkdtemp, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  acquireTree,
  shareTreeLocks,
  treeBusy,
  treeLockName,
  tryAcquireTree,
  withProjectLock,
  type TreeLockClient,
  type TreeLockDatabase,
} from './project-lock.js';

test('commands in the same project folder run one after another', async () => {
  const log: string[] = [];
  const task = (name: string, ms: number) =>
    withProjectLock('/p', async () => {
      log.push(`start ${name}`);
      await new Promise((done) => setTimeout(done, ms));
      log.push(`end ${name}`);
    });
  await Promise.all([
    task('a', 30),
    task('b', 1),
    withProjectLock('/other', async () => {
      log.push('other');
    }),
  ]);
  assert.deepEqual(
    log.filter((entry) => entry !== 'other'),
    ['start a', 'end a', 'start b', 'end b'],
  );
  await assert.rejects(
    withProjectLock('/p', async () => {
      throw new Error('x');
    }),
  );
  assert.equal(await withProjectLock('/p', async () => 'ok'), 'ok');
});

/**
 * Postgres-Advisory-Locks im Kleinen: Ein Lock gehört der Sitzung (Verbindung), die ihn genommen hat; endet die
 * Verbindung (Absturz des Workers), gibt „Postgres“ ihn frei.
 */
function fakeDatabase() {
  const held = new Map<string, number>();
  let sessions = 0;
  const connections: number[] = [];
  const drop = (session: number): void => {
    for (const [name, owner] of held) if (owner === session) held.delete(name);
  };
  const database: TreeLockDatabase = {
    async connect(): Promise<TreeLockClient> {
      const session = ++sessions;
      connections.push(session);
      return {
        async query(sql, params) {
          const name = String(params[0]);
          if (/pg_try_advisory_lock/.test(sql)) {
            const owner = held.get(name);
            if (owner !== undefined && owner !== session) return { rows: [{ locked: false }] };
            held.set(name, session);
            return { rows: [{ locked: true }] };
          }
          if (/pg_advisory_unlock/.test(sql) && held.get(name) === session) held.delete(name);
          return { rows: [] };
        },
        release() {
          connections.splice(connections.indexOf(session), 1);
          drop(session);
        },
      };
    },
  };
  return { database, held, connections, drop };
}

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

test('Arbeitsordner-Sperre: Symlink und echter Pfad sind derselbe Ordner (ein realpath-Schlüssel)', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'tree-real-'));
  const link = `${folder}-link`;
  await symlink(folder, link);
  assert.equal(treeLockName(link), treeLockName(folder));
  const first = await acquireTree(folder);
  assert.equal(treeBusy(link), true);
  assert.equal(await tryAcquireTree(link), null, 'über den Symlink nicht ein zweites Mal vergeben');
  let second = false;
  const waiting = acquireTree(link).then((release) => {
    second = true;
    return release;
  });
  await tick();
  assert.equal(second, false, 'zweiter Lauf wartet');
  first();
  (await waiting)();
  assert.equal(treeBusy(folder), false);
});

test('Arbeitsordner-Sperre: Freigabe im finally auch bei Fehler; Wartende bekommen einen Hinweis', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'tree-finally-'));
  const run = async (): Promise<void> => {
    const release = await acquireTree(folder);
    try {
      throw new Error('Agent abgestürzt');
    } finally {
      release();
    }
  };
  await assert.rejects(run(), /Agent abgestürzt/);
  assert.equal(treeBusy(folder), false);
  const first = await acquireTree(folder);
  let waits = 0;
  const waiting = acquireTree(folder, () => (waits += 1));
  first();
  first(); // doppelte Freigabe schadet nicht
  (await waiting)();
  assert.equal(waits, 1);
  assert.equal(treeBusy(folder), false);
});

test('Chat während des Entwickler-Schritts: Ordner belegt → nur lesen, kein zweites Schreibrecht', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'tree-chat-'));
  // Der Entwickler hält den Ordner (runWorkflow ab dem ersten ändernden Agent).
  const developer = await acquireTree(folder);
  // Der Chat würde jetzt `git checkout main` ausführen – er bekommt den Ordner nicht und läuft nur lesend.
  assert.equal(await tryAcquireTree(folder), null);
  developer();
  const chat = await tryAcquireTree(folder);
  assert.ok(chat, 'frei → Chat darf schreiben und hält den Ordner');
  assert.equal(await tryAcquireTree(folder), null, 'zwei schreibende Chats gleichzeitig gibt es nicht');
  chat();
});

test('Arbeitsordner-Sperre prozessübergreifend: anderer Worker hält den Ordner → warten bzw. nur lesen', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'tree-shared-'));
  const { database, held, connections } = fakeDatabase();
  // Ein anderer Worker (eigene Verbindung) hält den Advisory-Lock auf denselben realpath.
  const other = await database.connect();
  await other.query('SELECT pg_try_advisory_lock(hashtextextended($1, 0))', [treeLockName(`${folder}/.`)]);
  shareTreeLocks(database);
  try {
    assert.equal(treeBusy(folder), false, 'in diesem Prozess hält niemand den Ordner');
    assert.equal(await tryAcquireTree(folder), null, 'Chat läuft nur lesend');
    assert.equal(treeBusy(folder), false, 'gescheiterter Versuch hinterlässt keine Sperre');
    assert.equal(connections.length, 1, 'Verbindung des Versuchs ist zurückgegeben');
    let waits = 0;
    let acquired = false;
    const waiting = acquireTree(folder, () => (waits += 1)).then((release) => {
      acquired = true;
      return release;
    });
    await tick();
    assert.equal(acquired, false, 'Auftrag wartet auf den anderen Worker');
    assert.equal(waits, 1, 'genau ein Hinweis „wartet auf Arbeitsordner“');
    await other.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [treeLockName(folder)]);
    other.release();
    const release = await waiting;
    assert.equal(held.size, 1, 'jetzt hält dieser Worker den Lock');
    release();
    await tick();
    assert.equal(held.size, 0, 'Freigabe gibt auch den Advisory-Lock frei');
    assert.equal(connections.length, 0);
    assert.equal(treeBusy(folder), false);
  } finally {
    shareTreeLocks(null);
  }
});

test('Arbeitsordner-Sperre prozessübergreifend: abgestürzter Worker hinterlässt keine verwaiste Sperre', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'tree-crash-'));
  const { database, drop } = fakeDatabase();
  const crashed = await database.connect();
  await crashed.query('SELECT pg_try_advisory_lock(hashtextextended($1, 0))', [treeLockName(folder)]);
  shareTreeLocks(database);
  try {
    assert.equal(await tryAcquireTree(folder), null);
    // Absturz: Postgres beendet die Sitzung und gibt ihre Locks frei.
    drop(1);
    const release = await tryAcquireTree(folder);
    assert.ok(release, 'nach dem Absturz ist der Ordner wieder frei');
    release();
  } finally {
    shareTreeLocks(null);
  }
});

test('Arbeitsordner-Sperre: Fehler der Datenbank gibt die Sperre im Prozess wieder frei', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'tree-dberror-'));
  let released: unknown = 'nie';
  shareTreeLocks({
    async connect() {
      return {
        async query() {
          throw new Error('Datenbank weg');
        },
        release(error) {
          released = error;
        },
      };
    },
  });
  try {
    await assert.rejects(acquireTree(folder), /Datenbank weg/);
    assert.ok(released instanceof Error, 'kaputte Verbindung wird verworfen, nicht zurückgegeben');
    assert.equal(treeBusy(folder), false);
  } finally {
    shareTreeLocks(null);
  }
});
