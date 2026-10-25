import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';
import { withMigratedDatabase } from '../db/test-database.test.js';
import { registerDevelopmentRoutes } from './development.js';
import { registerReviewRoutes } from './review-routes.js';
import type { Principal } from './roles.js';
import { serveRoutes } from './serve-routes.test.js';

const admin: Principal = { id: null, username: 'admin', displayName: 'Admin', roles: ['admin'] };

type Order = { status: string; sprintId: string | null; autoRun: boolean };

/**
 * „Erneut versuchen“ und „Zurückweisen“ auf PostgreSQL: Ein Auftrag geht nur in geplante oder aktive Sprints zurück.
 * Ein Sprint im Review, abgeschlossen oder abgebrochen nimmt keine Arbeit mehr an – der Auftrag liefe sonst auf dessen
 * altem Branch (Code-Review vom 21.10.2026).
 */
test('Erneut versuchen auf PostgreSQL: nur in planbare Sprints, Ziel-Sprint atomar', async (t) => {
  await withMigratedDatabase(t, 'devlog_retry', async (db) => {
    const pool = db as unknown as Pool;
    await pool.query(
      `INSERT INTO projects (slug, name, repository) VALUES ('shop', 'Shop', '/tmp/shop'), ('other', 'Other', '/tmp/o')`,
    );
    const sprint = async (status: string, project = 'shop'): Promise<string> =>
      (
        await pool.query<{ id: string }>(
          `INSERT INTO sprints (project_slug, name, status) VALUES ($1, $2, $2) RETURNING id`,
          [project, status],
        )
      ).rows[0]!.id;
    const order = async (status: string, sprintId: string | null, kind = 'feature'): Promise<string> =>
      (
        await pool.query<{ id: string }>(
          `INSERT INTO development_items (project_slug, sprint_id, title, status, kind)
           VALUES ('shop', $1, 'Login', $2, $3) RETURNING id`,
          [sprintId, status, kind],
        )
      ).rows[0]!.id;
    const read = async (id: string): Promise<Order> =>
      (
        await pool.query<Order>(
          `SELECT status, sprint_id AS "sprintId", auto_run AS "autoRun" FROM development_items WHERE id = $1`,
          [id],
        )
      ).rows[0]!;

    const client = await serveRoutes(admin, (router) => {
      registerDevelopmentRoutes(router, pool);
      registerReviewRoutes(router, pool);
    });
    try {
      const retry = (id: string, body: unknown = {}) => client.call('POST', `/development/${id}/retry`, body);
      const active = await sprint('active');
      const planned = await sprint('planned');

      // Ohne Wahl: bisheriger Sprint nur, wenn er noch geplant oder aktiv ist, sonst der aktive Sprint.
      for (const status of ['completed', 'cancelled', 'review']) {
        const id = await order('blocked', await sprint(status));
        const response = await retry(id);
        assert.equal(response.status, 200, status);
        assert.equal(response.body.item.sprintId, active, `${status}: in den aktiven Sprint`);
        assert.deepEqual(await read(id), { status: 'planned', sprintId: active, autoRun: true }, status);
      }

      // Geplanter Sprint bleibt, startet aber erst mit dem Sprint (kein auto_run).
      const inPlanned = await order('rejected', planned);
      assert.equal((await retry(inPlanned)).status, 200);
      assert.deepEqual(await read(inPlanned), { status: 'planned', sprintId: planned, autoRun: false });

      // Aktiver Sprint bleibt.
      const inActive = await order('blocked', active);
      assert.equal((await retry(inActive)).status, 200);
      assert.deepEqual(await read(inActive), { status: 'planned', sprintId: active, autoRun: true });

      // Gewählter geplanter Sprint: Status und Sprint stehen nach einem einzigen Aufruf zusammen, nie im aktiven Sprint.
      const moved = await order('blocked', await sprint('completed'));
      const response = await retry(moved, { sprintId: planned, comment: 'Bitte nochmal' });
      assert.equal(response.status, 200);
      assert.equal(response.body.item.sprintId, planned);
      assert.deepEqual(await read(moved), { status: 'planned', sprintId: planned, autoRun: false });
      assert.match(response.body.item.description, /Bitte nochmal/);

      // Gewählter Sprint im Review, abgeschlossen, abgebrochen oder aus fremdem Projekt: 409, nichts geschrieben.
      for (const target of [
        await sprint('review'),
        await sprint('completed'),
        await sprint('cancelled'),
        await sprint('active', 'other'),
      ]) {
        const id = await order('blocked', null);
        const refused = await retry(id, { sprintId: target });
        assert.equal(refused.status, 409);
        assert.match(refused.body.message, /geplante oder aktive Sprints/);
        assert.deepEqual(await read(id), { status: 'blocked', sprintId: null, autoRun: false });
      }

      // Ungültige Sprint-ID: 400 ohne Schreibzugriff.
      const invalid = await order('blocked', null);
      assert.equal((await retry(invalid, { sprintId: 'kein-sprint' })).status, 400);
      assert.equal((await read(invalid)).status, 'blocked');

      // Status-Wächter bleibt: aus „in Arbeit“ kein Retry, auch nicht mit Sprint.
      const running = await order('in_progress', active);
      const busy = await retry(running, { sprintId: planned });
      assert.equal(busy.status, 409);
      assert.match(busy.body.message, /Nur blockierte, abgelehnte/);
      assert.equal((await read(running)).status, 'in_progress');

      // Zurückweisen in der Freigabe: dieselbe Sprint-Wahl, auto_run folgt dem Ziel-Sprint.
      const reject = (id: string) => client.call('POST', `/development/${id}/review-reject`, { comment: 'Passt nicht' });
      const inReview = await order('approval', await sprint('review'));
      assert.equal((await reject(inReview)).status, 200);
      assert.deepEqual(await read(inReview), { status: 'planned', sprintId: active, autoRun: true });
      const rejectedPlanned = await order('approval', planned);
      assert.equal((await reject(rejectedPlanned)).status, 200);
      assert.deepEqual(await read(rejectedPlanned), { status: 'planned', sprintId: planned, autoRun: false });

      // Ohne aktiven Sprint: ohne Sprint auf main, dort startet auto_run den Auftrag.
      await pool.query(`UPDATE sprints SET status = 'completed' WHERE id = $1`, [active]);
      const orphan = await order('blocked', await sprint('cancelled'));
      assert.equal((await retry(orphan)).status, 200);
      assert.deepEqual(await read(orphan), { status: 'planned', sprintId: null, autoRun: true });
    } finally {
      await client.close();
    }
  });
});
