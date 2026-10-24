import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';
import { applyProposal } from '../api/sprint-planning.js';
import { detachFromClosedSprints, GIT_FOLDER_TODO, resumeAfterEnvironment } from './autofix.js';
import { selectItems } from './runner-selection.js';
import { withMigratedDatabase } from '../db/test-database.test.js';

const options = { project: 'alpha', cwd: '/tmp', limit: 10 } as Parameters<typeof selectItems>[1];

async function sprint(db: Pool, name: string, status: string): Promise<string> {
  return (
    await db.query<{ id: string }>(
      `INSERT INTO sprints (project_slug, name, status) VALUES ('alpha', $1, $2) RETURNING id`,
      [name, status],
    )
  ).rows[0]!.id;
}

async function order(db: Pool, title: string, fields: Record<string, unknown>): Promise<string> {
  const columns = Object.keys(fields);
  return (
    await db.query<{ id: string }>(
      `INSERT INTO development_items (project_slug, title${columns.map((column) => `, ${column}`).join('')})
       VALUES ('alpha', $1${columns.map((_, index) => `, $${index + 2}`).join('')}) RETURNING id`,
      [title, ...Object.values(fields)],
    )
  ).rows[0]!.id;
}

const row = async (db: Pool, id: string) =>
  (
    await db.query<{ status: string; sprintId: string | null; actionTodo: string | null; autoRun: boolean }>(
      `SELECT status, sprint_id AS "sprintId", action_todo AS "actionTodo", auto_run AS "autoRun"
         FROM development_items WHERE id = $1`,
      [id],
    )
  ).rows[0]!;

test('Neu einplanen auf PostgreSQL: geschlossene Sprints, alte Git-Vermerke, Sprintvorschlag', async (t) => {
  await withMigratedDatabase(t, 'devlog_requeue', async (db) => {
    await db.query(`INSERT INTO projects (slug, name, repository) VALUES ('alpha', 'Alpha', '/tmp/a')`);

    await t.test('auto_run läuft nur ohne Sprint oder im aktiven Sprint; geschlossene Sprints geben ab', async () => {
      const closed = await sprint(db, 'Sprint 1', 'completed');
      const planned = await sprint(db, 'Sprint 3', 'planned');
      const review = await sprint(db, 'Sprint 0', 'review');
      const bugfix = await order(db, 'Bugfix im alten Sprint', {
        status: 'planned',
        auto_run: true,
        sprint_id: closed,
      });
      const early = await order(db, 'Retry im geplanten Sprint', {
        status: 'planned',
        auto_run: true,
        sprint_id: planned,
      });
      const waiting = await order(db, 'Im Review-Sprint', { status: 'planned', auto_run: true, sprint_id: review });
      const free = await order(db, 'Ohne Sprint', { status: 'planned', auto_run: true });
      // Vorher drehte sich „bugfix“ endlos: gewählt, von sprintPaused angehalten, wieder „Geplant“.
      assert.deepEqual(
        (await selectItems(db, options)).map((item) => item.id),
        [free],
      );
      assert.equal(await detachFromClosedSprints(db, 'alpha'), 1);
      assert.equal((await row(db, bugfix)).sprintId, null, 'ohne aktiven Sprint: auf main');
      assert.equal((await row(db, waiting)).sprintId, review, 'Review-Sprint behält seine Aufträge');
      assert.deepEqual(new Set((await selectItems(db, options)).map((item) => item.id)), new Set([free, bugfix]));
      const active = await sprint(db, 'Sprint 2', 'active');
      const late = await order(db, 'Später Bugfix', { status: 'planned', auto_run: true, sprint_id: closed });
      await detachFromClosedSprints(db, 'alpha');
      assert.equal((await row(db, late)).sprintId, active, 'mit aktivem Sprint: dorthin');
      assert.ok(!(await selectItems(db, options)).some((item) => item.id === early), 'geplanter Sprint wartet');
      await db.query(`DELETE FROM development_items`);
      await db.query(`DELETE FROM sprints`);
    });

    await t.test('Alter Vermerk „Arbeitsordner aufräumen (Git)“ startet von selbst wieder', async () => {
      const active = await sprint(db, 'Sprint 20', 'active');
      const stuck = await order(db, 'Vom Vorfall', {
        status: 'blocked',
        sprint_id: active,
        action_todo: GIT_FOLDER_TODO,
      });
      const human = await order(db, 'Wartet auf Mensch', {
        status: 'blocked',
        sprint_id: active,
        action_todo: 'Zugangsdaten hinterlegen bzw. anmelden',
      });
      await resumeAfterEnvironment(db, 'alpha');
      assert.deepEqual(await row(db, stuck), { status: 'planned', sprintId: active, actionTodo: null, autoRun: true });
      assert.equal((await row(db, human)).status, 'blocked');
      await db.query(`DELETE FROM development_items`);
      await db.query(`DELETE FROM sprints`);
    });

    await t.test('Sprintvorschlag übernimmt Blockierte als neu eingeplant, ohne alten Vermerk', async () => {
      const old = await sprint(db, 'Sprint 20', 'completed');
      const stuck = await order(db, 'Vom Vorfall', {
        status: 'blocked',
        sprint_id: old,
        action_todo: GIT_FOLDER_TODO,
        failure: 'fremde Änderungen',
        effort_hours: 2,
      });
      const fresh = await order(db, 'Neu', { status: 'backlog', effort_hours: 2 });
      const result = await applyProposal(db, 'alpha', [stuck, fresh], true);
      assert.equal(typeof result, 'object', String(result));
      const { sprintId } = result as { sprintId: string };
      assert.deepEqual(await row(db, stuck), { status: 'planned', sprintId, actionTodo: null, autoRun: true });
      assert.equal((await row(db, fresh)).status, 'planned');
      const failure = (await db.query(`SELECT failure FROM development_items WHERE id = $1`, [stuck])).rows[0];
      assert.equal(failure.failure, null);
    });
  });
});
