import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import type { Pool } from 'pg';
import { createDevLogApp } from '../api/app.js';
import { MIGRATIONS } from './migrations.js';
import { withMigratedDatabase } from './test-database.test.js';
import { isUniqueViolation, withTransaction } from './transaction.js';

/** Pool-Attrappe mit fester Verbindung; fail = SQL, das scheitert; release merkt sich das übergebene Argument. */
function fakePool(fail: string[] = []) {
  const queries: string[] = [];
  const released: unknown[] = [];
  const client = {
    async query(sql: string) {
      queries.push(sql);
      if (fail.includes(sql)) throw new Error(`${sql} fehlgeschlagen`);
      return { rows: [] };
    },
    release(error?: unknown) {
      released.push(error);
    },
  };
  const pool = { connect: async () => client } as unknown as Pool;
  return { pool, queries, released };
}

test('withTransaction: BEGIN, Arbeit über dieselbe Verbindung, COMMIT, Verbindung zurück', async () => {
  const { pool, queries, released } = fakePool();
  const result = await withTransaction(pool, async (client) => {
    await client.query('UPDATE a');
    await client.query('UPDATE b');
    return 42;
  });
  assert.equal(result, 42);
  assert.deepEqual(queries, ['BEGIN', 'UPDATE a', 'UPDATE b', 'COMMIT']);
  assert.deepEqual(released, [undefined]);
});

test('withTransaction: Fehler im zweiten Schritt rollt zurück und reicht den Fehler weiter', async () => {
  const { pool, queries, released } = fakePool(['UPDATE b']);
  await assert.rejects(
    withTransaction(pool, async (client) => {
      await client.query('UPDATE a');
      await client.query('UPDATE b');
    }),
    /UPDATE b fehlgeschlagen/,
  );
  assert.deepEqual(queries, ['BEGIN', 'UPDATE a', 'UPDATE b', 'ROLLBACK']);
  assert.deepEqual(released, [undefined]);
});

test('withTransaction: scheitert auch ROLLBACK, wird die Verbindung verworfen statt zurückgegeben', async () => {
  const { pool, released } = fakePool(['UPDATE a', 'ROLLBACK']);
  await assert.rejects(
    withTransaction(pool, (client) => client.query('UPDATE a')),
    /UPDATE a fehlgeschlagen/,
  );
  assert.equal(released.length, 1);
  assert.match(String(released[0]), /ROLLBACK fehlgeschlagen/);
});

test('withTransaction: scheitert COMMIT, wird zurückgerollt und der Fehler gemeldet', async () => {
  const { pool, queries } = fakePool(['COMMIT']);
  await assert.rejects(
    withTransaction(pool, async () => 1),
    /COMMIT fehlgeschlagen/,
  );
  assert.deepEqual(queries, ['BEGIN', 'COMMIT', 'ROLLBACK']);
});

test('isUniqueViolation erkennt nur PostgreSQL 23505', () => {
  assert.ok(isUniqueViolation({ code: '23505' }));
  assert.ok(!isUniqueViolation({ code: '23503' }));
  assert.ok(!isUniqueViolation(new Error('x')));
  assert.ok(!isUniqueViolation(null));
});

async function withApi(pool: Pool, run: (base: string) => Promise<void>): Promise<void> {
  const server = createDevLogApp(pool, null).listen(0, '127.0.0.1');
  try {
    await new Promise<void>((resolve) => server.once('listening', resolve));
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('Transaktionen auf PostgreSQL: Doppelklick auf „Übernehmen“, Rollback, Löschen, Altdaten', async (t) => {
  await withMigratedDatabase(t, 'devlog_tx', async (db) => {
    const pool = db as unknown as Pool;
    await pool.query(`INSERT INTO projects (slug, name, repository) VALUES ('shop', 'Shop', '/tmp/shop')`);
    const idea = async (title: string) =>
      (
        await pool.query<{ id: string }>(
          `INSERT INTO ideation_items (project_slug, title) VALUES ('shop', $1) RETURNING id`,
          [title],
        )
      ).rows[0]!.id;
    const orders = async (ideaId: string) =>
      (await pool.query('SELECT 1 FROM development_items WHERE ideation_id = $1', [ideaId])).rowCount;
    const ideaStatus = async (ideaId: string) =>
      (await pool.query<{ status: string }>('SELECT status FROM ideation_items WHERE id = $1', [ideaId])).rows[0]
        ?.status;

    await t.test('zwei parallele promote-Aufrufe: genau einer gewinnt, der andere bekommt 409', async () => {
      const ideaId = await idea('Doppelklick');
      await withApi(pool, async (base) => {
        const promote = () => fetch(`${base}/ideation/${ideaId}/promote`, { method: 'POST' });
        const statuses = (await Promise.all([promote(), promote()])).map((response) => response.status).sort();
        assert.deepEqual(statuses, [201, 409]);
      });
      assert.equal(await orders(ideaId), 1);
      assert.equal(await ideaStatus(ideaId), 'accepted');
    });

    await t.test('Unique-Index: ein zweiter Auftrag zur selben Idee scheitert mit 23505', async () => {
      const ideaId = await idea('Von Hand');
      await withApi(pool, async (base) => {
        const create = () =>
          fetch(`${base}/projects/shop/development`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: 'Auftrag', ideationId: ideaId }),
          });
        assert.equal((await create()).status, 201);
        const second = await create();
        assert.equal(second.status, 409);
        assert.equal(((await second.json()) as { field?: string }).field, 'ideationId');
      });
      assert.equal(await orders(ideaId), 1);
      // Ohne Idee (ideation_id NULL) gilt der Index nicht.
      await pool.query(`INSERT INTO development_items (project_slug, title) VALUES ('shop', 'a'), ('shop', 'b')`);
    });

    await t.test('Fehler im zweiten Schritt: vom ersten bleibt nichts übrig', async () => {
      const ideaId = await idea('Rollback');
      await assert.rejects(
        withTransaction(pool, async (client) => {
          await client.query(
            `INSERT INTO development_items (project_slug, ideation_id, title) VALUES ('shop', $1, 'Auftrag')`,
            [ideaId],
          );
          await client.query(`UPDATE ideation_items SET status = 'gibt-es-nicht' WHERE id = $1`, [ideaId]);
        }),
      );
      assert.equal(await orders(ideaId), 0);
      assert.equal(await ideaStatus(ideaId), 'idea');
    });

    await t.test('Auftrag löschen öffnet die Idee wieder', async () => {
      const ideaId = await idea('Löschen');
      await withApi(pool, async (base) => {
        const promoted = await fetch(`${base}/ideation/${ideaId}/promote`, { method: 'POST' });
        const { item } = (await promoted.json()) as { item: { id: string } };
        assert.equal((await fetch(`${base}/development/${item.id}`, { method: 'DELETE' })).status, 204);
      });
      assert.equal(await orders(ideaId), 0);
      assert.equal(await ideaStatus(ideaId), 'idea');
    });

    await t.test('Migration 19: vorhandene Doppel behalten ihre Arbeit, nur der älteste bleibt verknüpft', async () => {
      const ideaId = await idea('Altbestand');
      await pool.query('DROP INDEX development_items_ideation_idx');
      const ids = [];
      for (const title of ['erster', 'zweiter']) {
        ids.push(
          (
            await pool.query<{ id: string }>(
              `INSERT INTO development_items (project_slug, ideation_id, title, created_at)
               VALUES ('shop', $1, $2, NOW() - make_interval(mins => $3)) RETURNING id`,
              [ideaId, title, title === 'erster' ? 10 : 5],
            )
          ).rows[0]!.id,
        );
      }
      await pool.query(MIGRATIONS.find((migration) => migration.version === 19)!.sql);
      const rows = await pool.query<{ title: string; linked: boolean }>(
        `SELECT title, ideation_id IS NOT NULL AS linked FROM development_items WHERE id = ANY($1) ORDER BY title`,
        [ids],
      );
      assert.deepEqual(rows.rows, [
        { title: 'erster', linked: true },
        { title: 'zweiter', linked: false },
      ]);
    });
  });
});
