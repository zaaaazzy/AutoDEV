import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';
import { isUntrustedBugSource } from '../core/bug-trust.js';
import { withMigratedDatabase } from '../db/test-database.test.js';
import { registerBugRoutes } from './bugs.js';
import { registerDevelopmentRoutes } from './development.js';
import { registerReviewRoutes } from './review-routes.js';
import type { Principal } from './roles.js';
import { serveRoutes } from './serve-routes.test.js';
import { registerSprintRoutes } from './sprints.js';

const admin: Principal = { id: null, username: 'admin', displayName: 'Admin', roles: ['admin'] };
const BUG_SOURCES = ['manual', 'agent', 'test', 'production', 'github', 'routine'];

/**
 * Status- und Sprintwechsel von Aufträgen, Sprints und Bugs auf PostgreSQL (Code-Review vom 21.10.2026): je Regel ein
 * erlaubter und ein abgelehnter Fall. Bei Ablehnungen wird der Datenbankstand geprüft (nichts geschrieben, kein
 * Git-Sync), beim Bug-Status die Kopplung an den Auftrag (Trigger in derselben Anweisung).
 */
test('Aufträge, Sprints und Bugs auf PostgreSQL: erlaubte und abgelehnte Wechsel', async (t) => {
  await withMigratedDatabase(t, 'devlog_order_rules', async (db) => {
    const pool = db as unknown as Pool;
    let projects = 0;
    // Je Teiltest ein eigenes Projekt: pro Projekt ist nur ein Sprint aktiv.
    const project = async (): Promise<string> => {
      const slug = `p${(projects += 1)}`;
      await pool.query(`INSERT INTO projects (slug, name, repository) VALUES ($1, $1, '/tmp/' || $1)`, [slug]);
      return slug;
    };
    const sprint = async (slug: string, status: string, name = status): Promise<string> =>
      (
        await pool.query<{ id: string }>(
          `INSERT INTO sprints (project_slug, name, status) VALUES ($1, $2, $3) RETURNING id`,
          [slug, `${name}-${slug}`, status],
        )
      ).rows[0]!.id;
    const order = async (
      slug: string,
      status: string,
      sprintId: string | null,
      extra: { bugId?: string; kind?: string } = {},
    ): Promise<string> =>
      (
        await pool.query<{ id: string }>(
          `INSERT INTO development_items (project_slug, sprint_id, title, description, status, kind, bug_id)
           VALUES ($1, $2, 'Login', 'Text', $3, $4, $5) RETURNING id`,
          [slug, sprintId, status, extra.kind ?? (extra.bugId ? 'bug' : 'feature'), extra.bugId ?? null],
        )
      ).rows[0]!.id;
    const bug = async (slug: string, status = 'open', source = 'manual'): Promise<string> =>
      (
        await pool.query<{ id: string }>(
          `INSERT INTO bugs (project_slug, title, description, severity, status, source)
           VALUES ($1, 'Knopf', 'kaputt', 'high', $2, $3) RETURNING id`,
          [slug, status, source],
        )
      ).rows[0]!.id;
    /** Ganze Zeile als Vergleichsstand: Ein abgelehnter Aufruf darf keine Spalte ändern (auch nicht updated_at). */
    const row = async (table: 'development_items' | 'sprints' | 'bugs', id: string) =>
      (await pool.query(`SELECT * FROM ${table} WHERE id = $1`, [id])).rows[0] as Record<string, unknown> | undefined;
    const count = async (sql: string, values: unknown[] = []): Promise<number> =>
      Number((await pool.query<{ count: string }>(sql, values)).rows[0]!.count);

    const api = await serveRoutes(admin, (router) => {
      registerDevelopmentRoutes(router, pool);
      registerReviewRoutes(router, pool);
      registerSprintRoutes(router, pool);
      registerBugRoutes(router, pool);
    });
    try {
      await t.test('Anlegen: Backlog und Geplant erlaubt, jeder andere Status 400 ohne Zeile', async () => {
        const slug = await project();
        const created = await api.call('POST', `/projects/${slug}/development`, { title: 'Neu', status: 'planned' });
        assert.equal(created.status, 201);
        assert.equal((await row('development_items', created.body.item.id))?.status, 'planned');

        const before = await count('SELECT count(*) FROM development_items WHERE project_slug = $1', [slug]);
        for (const status of ['in_progress', 'approval', 'done', 'blocked', 'rejected']) {
          const refused = await api.call('POST', `/projects/${slug}/development`, { title: 'Neu', status });
          assert.equal(refused.status, 400, status);
        }
        assert.equal(await count('SELECT count(*) FROM development_items WHERE project_slug = $1', [slug]), before);
      });

      await t.test('PATCH Status: erlaubter Wechsel speichert, verbotener 409 ohne Schreibzugriff', async () => {
        const slug = await project();
        const planned = await order(slug, 'planned', null);
        assert.equal((await api.call('PATCH', `/development/${planned}`, { status: 'backlog' })).status, 200);
        assert.equal((await row('development_items', planned))?.status, 'backlog');

        const done = await order(slug, 'done', null);
        const before = await row('development_items', done);
        const refused = await api.call('PATCH', `/development/${done}`, { status: 'planned', title: 'Anders' });
        assert.equal(refused.status, 409);
        assert.deepEqual(await row('development_items', done), before);
      });

      await t.test('PATCH Sprint: geplanter Sprint erlaubt (ohne auto_run), abgeschlossener 409', async () => {
        const slug = await project();
        const plannedSprint = await sprint(slug, 'planned');
        const completedSprint = await sprint(slug, 'completed');
        const id = await order(slug, 'backlog', null);
        await pool.query('UPDATE development_items SET auto_run = TRUE WHERE id = $1', [id]);

        const before = await row('development_items', id);
        const refused = await api.call('PATCH', `/development/${id}`, { sprintId: completedSprint });
        assert.equal(refused.status, 409);
        assert.deepEqual(await row('development_items', id), before);

        assert.equal((await api.call('PATCH', `/development/${id}`, { sprintId: plannedSprint })).status, 200);
        const after = await row('development_items', id);
        assert.deepEqual(
          { sprint: after?.sprint_id, status: after?.status, autoRun: after?.auto_run },
          { sprint: plannedSprint, status: 'planned', autoRun: false },
        );

        // Laufender Auftrag bleibt in seinem Sprint.
        const running = await order(slug, 'in_progress', plannedSprint);
        const runningBefore = await row('development_items', running);
        assert.equal((await api.call('PATCH', `/development/${running}`, { sprintId: null })).status, 409);
        assert.deepEqual(await row('development_items', running), runningBefore);
      });

      await t.test('Retry: Bug-Auftrag öffnet den Bug wieder, zweiter Versuch 409 ohne Änderung', async () => {
        const slug = await project();
        const active = await sprint(slug, 'active');
        const bugId = await bug(slug, 'rejected');
        const id = await order(slug, 'rejected', active, { bugId });

        const retried = await api.call('POST', `/development/${id}/retry`, { comment: 'Bitte nochmal' });
        assert.equal(retried.status, 200);
        assert.equal((await row('development_items', id))?.status, 'planned');
        assert.equal((await row('bugs', bugId))?.status, 'open', 'Bug folgt dem Auftrag');

        const orderBefore = await row('development_items', id);
        const bugBefore = await row('bugs', bugId);
        const again = await api.call('POST', `/development/${id}/retry`, {});
        assert.equal(again.status, 409);
        assert.deepEqual(await row('development_items', id), orderBefore);
        assert.deepEqual(await row('bugs', bugId), bugBefore);

        // Blockierter Bug-Auftrag: Bug in Arbeit wird wieder offen, retry_count zählt hoch.
        const blockedBug = await bug(slug, 'in_progress');
        const blocked = await order(slug, 'blocked', active, { bugId: blockedBug });
        assert.equal((await api.call('POST', `/development/${blocked}/retry`, {})).status, 200);
        assert.equal((await row('bugs', blockedBug))?.status, 'open');
        assert.equal((await row('development_items', blocked))?.retry_count, 1);

        // Express-Anfragen laufen im Chat weiter, nicht über /retry.
        const express = await order(slug, 'blocked', null, { kind: 'express' });
        const expressBefore = await row('development_items', express);
        assert.equal((await api.call('POST', `/development/${express}/retry`, {})).status, 409);
        assert.deepEqual(await row('development_items', express), expressBefore);
      });

      await t.test('review-reject: zurück an die Agents, Bug wieder offen; sonst 400/409', async () => {
        const slug = await project();
        const active = await sprint(slug, 'active');
        const bugId = await bug(slug, 'in_progress');
        const id = await order(slug, 'approval', active, { bugId });
        await pool.query(`UPDATE development_items SET review_since = NOW() WHERE id = $1`, [id]);

        const before = await row('development_items', id);
        assert.equal((await api.call('POST', `/development/${id}/review-reject`, { comment: '  ' })).status, 400);
        assert.deepEqual(await row('development_items', id), before);

        const rejected = await api.call('POST', `/development/${id}/review-reject`, { comment: 'Knopf fehlt' });
        assert.equal(rejected.status, 200);
        const after = await row('development_items', id);
        assert.equal(after?.status, 'planned');
        assert.equal(after?.sprint_id, active);
        assert.equal(after?.review_since, null);
        assert.match(String(after?.description), /Rückmeldung aus der Review-Freigabe[^]*Knopf fehlt/);
        assert.equal((await row('bugs', bugId))?.status, 'open', 'Bug folgt dem Auftrag');

        // Schon freigegeben (Merge steht aus) oder gar nicht in Freigabe: 409, nichts geändert.
        const approved = await order(slug, 'approval', active);
        await pool.query(`UPDATE development_items SET review_approved_at = NOW() WHERE id = $1`, [approved]);
        const running = await order(slug, 'in_progress', active);
        for (const refusedId of [approved, running]) {
          const refusedBefore = await row('development_items', refusedId);
          assert.equal(
            (await api.call('POST', `/development/${refusedId}/review-reject`, { comment: 'Nein' })).status,
            409,
          );
          assert.deepEqual(await row('development_items', refusedId), refusedBefore);
        }
      });

      await t.test('Aus dem Sprint nehmen: geplanter aus aktivem Sprint mit Vermerk; laufender 409', async () => {
        const slug = await project();
        const active = await sprint(slug, 'active', 'Laufend');
        const id = await order(slug, 'planned', active);
        assert.equal((await api.call('POST', `/development/${id}/remove-from-sprint`)).status, 200);
        const after = await row('development_items', id);
        assert.deepEqual(
          { sprint: after?.sprint_id, status: after?.status, removed: after?.removed_from_sprint },
          { sprint: null, status: 'backlog', removed: `Laufend-${slug}` },
        );
        assert.notEqual(after?.removed_from_sprint_at, null);

        const running = await order(slug, 'in_progress', active);
        const completedSprint = await sprint(slug, 'completed');
        const inCompleted = await order(slug, 'planned', completedSprint);
        for (const refusedId of [running, inCompleted]) {
          const before = await row('development_items', refusedId);
          assert.equal((await api.call('POST', `/development/${refusedId}/remove-from-sprint`)).status, 409);
          assert.deepEqual(await row('development_items', refusedId), before);
        }
      });

      await t.test('Folgeauftrag: zu erledigtem Auftrag in geplanten Sprint; sonst ohne neue Zeile', async () => {
        const slug = await project();
        const plannedSprint = await sprint(slug, 'planned');
        const done = await order(slug, 'done', null);
        const created = await api.call('POST', `/development/${done}/follow-up`, {
          title: 'Nachtrag',
          sprintId: plannedSprint,
        });
        assert.equal(created.status, 201);
        const followUp = await row('development_items', created.body.item.id);
        assert.deepEqual(
          { status: followUp?.status, sprint: followUp?.sprint_id, of: followUp?.follow_up_of },
          { status: 'planned', sprint: plannedSprint, of: done },
        );

        const other = await project();
        const foreignSprint = await sprint(other, 'planned');
        const cancelledSprint = await sprint(slug, 'cancelled');
        const open = await order(slug, 'planned', null);
        const before = await count('SELECT count(*) FROM development_items WHERE follow_up_of IS NOT NULL');
        const refused: [string, unknown, number][] = [
          [open, { title: 'Nachtrag' }, 400],
          [done, { title: 'Nachtrag', sprintId: cancelledSprint }, 409],
          [done, { title: 'Nachtrag', sprintId: foreignSprint }, 400],
          [done, { title: '' }, 400],
        ];
        for (const [id, body, status] of refused) {
          const response = await api.call('POST', `/development/${id}/follow-up`, body);
          assert.equal(response.status, status, JSON.stringify(body));
        }
        assert.equal(await count('SELECT count(*) FROM development_items WHERE follow_up_of IS NOT NULL'), before);
      });

      await t.test('Sprint abschliessen: laufender Auftrag 409 ohne Git-Sync, sonst Bericht und Sync', async () => {
        const slug = await project();
        const active = await sprint(slug, 'active');
        const running = await order(slug, 'in_progress', active);

        const before = await row('sprints', active);
        assert.equal((await api.call('PATCH', `/sprints/${active}`, { status: 'completed' })).status, 409);
        assert.deepEqual(await row('sprints', active), before);
        assert.equal(before?.git_sync, null);

        await pool.query(`UPDATE development_items SET status = 'done' WHERE id = $1`, [running]);
        const completed = await api.call('PATCH', `/sprints/${active}`, { status: 'completed' });
        assert.equal(completed.status, 200);
        const after = await row('sprints', active);
        assert.deepEqual(
          { status: after?.status, gitSync: after?.git_sync },
          { status: 'completed', gitSync: 'pending' },
        );
        assert.equal(await count('SELECT count(*) FROM sprint_reports WHERE sprint_id = $1', [active]), 1);
      });

      await t.test('Sprint wieder öffnen: completed → active, cancelled → planned; andere Wege 409', async () => {
        const slug = await project();
        const completed = await sprint(slug, 'completed');
        const cancelled = await sprint(slug, 'cancelled');

        // Abgebrochen → aktiv ist kein erlaubter Wechsel; abgeschlossen → geplant ebenso nicht.
        for (const [id, status] of [
          [cancelled, 'active'],
          [completed, 'planned'],
        ] as const) {
          const before = await row('sprints', id);
          assert.equal((await api.call('PATCH', `/sprints/${id}`, { status })).status, 409, status);
          assert.deepEqual(await row('sprints', id), before);
        }

        assert.equal((await api.call('PATCH', `/sprints/${cancelled}`, { status: 'planned' })).status, 200);
        assert.equal((await row('sprints', cancelled))?.status, 'planned');

        const reopened = await api.call('PATCH', `/sprints/${completed}`, { status: 'active' });
        assert.equal(reopened.status, 200);
        const after = await row('sprints', completed);
        assert.equal(after?.status, 'active');
        assert.equal(after?.git_sync, null, 'Wieder öffnen löst keinen Git-Sync aus');

        // Nur ein aktiver Sprint je Projekt.
        const second = await sprint(slug, 'planned', 'zweiter');
        const secondBefore = await row('sprints', second);
        assert.equal((await api.call('PATCH', `/sprints/${second}`, { status: 'active' })).status, 409);
        assert.deepEqual(await row('sprints', second), secondBefore);

        // Sprint im Review schliesst nur der Worker ab.
        const review = await sprint(slug, 'review');
        const reviewBefore = await row('sprints', review);
        assert.equal((await api.call('PATCH', `/sprints/${review}`, { status: 'completed' })).status, 409);
        assert.deepEqual(await row('sprints', review), reviewBefore);
      });

      await t.test('Sprint löschen: geplanter geht, Aufträge ins Backlog; sonst 409 ohne Änderung', async () => {
        const slug = await project();
        const planned = await sprint(slug, 'planned');
        const waiting = await order(slug, 'planned', planned);
        assert.equal((await api.call('DELETE', `/sprints/${planned}`)).status, 204);
        assert.equal(await row('sprints', planned), undefined);
        const freed = await row('development_items', waiting);
        assert.deepEqual({ status: freed?.status, sprint: freed?.sprint_id }, { status: 'backlog', sprint: null });

        const active = await sprint(slug, 'active');
        const completed = await sprint(slug, 'completed', 'mit-freigabe');
        const inApproval = await order(slug, 'approval', completed);
        const syncing = await sprint(slug, 'completed', 'sync');
        await pool.query(`UPDATE sprints SET git_sync = 'pending' WHERE id = $1`, [syncing]);
        const plannedInSyncing = await order(slug, 'planned', syncing);
        for (const id of [active, completed, syncing]) {
          const before = await row('sprints', id);
          assert.equal((await api.call('DELETE', `/sprints/${id}`)).status, 409);
          assert.deepEqual(await row('sprints', id), before);
        }
        assert.equal((await row('development_items', inApproval))?.sprint_id, completed);
        // Abgelehntes Löschen setzt auch keine Aufträge ins Backlog zurück.
        assert.equal((await row('development_items', plannedInSyncing))?.status, 'planned');
      });

      await t.test('Bug-Zuordnung: jede Quelle nur in geplante oder aktive Sprints, sonst 409', async () => {
        const slug = await project();
        const assignable = { planned: await sprint(slug, 'planned'), active: await sprint(slug, 'active') };
        const closed = {
          review: await sprint(slug, 'review'),
          completed: await sprint(slug, 'completed'),
          cancelled: await sprint(slug, 'cancelled'),
        };
        for (const source of BUG_SOURCES) {
          const untrusted = isUntrustedBugSource(source);
          for (const [status, sprintId] of Object.entries(closed)) {
            const id = await bug(slug, 'open', source);
            const before = await row('bugs', id);
            assert.equal((await api.call('PATCH', `/bugs/${id}`, { sprintId })).status, 409, `${source} → ${status}`);
            assert.deepEqual(await row('bugs', id), before);
            assert.equal(await count('SELECT count(*) FROM development_items WHERE bug_id = $1', [id]), 0);
          }
          for (const [status, sprintId] of Object.entries(assignable)) {
            const id = await bug(slug, 'open', source);
            assert.equal((await api.call('PATCH', `/bugs/${id}`, { sprintId })).status, 200, `${source} → ${status}`);
            assert.equal((await row('bugs', id))?.sprint_id, sprintId);
            // Fremde Quellen bekommen ihren Auftrag erst mit der Freigabe.
            const inSprint = 'SELECT count(*) FROM development_items WHERE bug_id = $1 AND sprint_id = $2';
            assert.equal(await count(inSprint, [id, sprintId]), untrusted ? 0 : 1, `${source} → ${status}: Auftrag`);
          }
        }
      });

      await t.test('Bug anlegen: aktiver Sprint erlaubt, abgeschlossener 409; alter Sprint bleibt', async () => {
        const slug = await project();
        const active = await sprint(slug, 'active');
        const completed = await sprint(slug, 'completed');
        const before = await count('SELECT count(*) FROM bugs WHERE project_slug = $1', [slug]);
        const refused = await api.call('POST', `/projects/${slug}/bugs`, { title: 'Bug', sprintId: completed });
        assert.equal(refused.status, 409);
        assert.equal(await count('SELECT count(*) FROM bugs WHERE project_slug = $1', [slug]), before);

        const created = await api.call('POST', `/projects/${slug}/bugs`, { title: 'Bug', sprintId: active });
        assert.equal(created.status, 201);
        assert.equal(await count('SELECT count(*) FROM development_items WHERE bug_id = $1', [created.body.bug.id]), 1);

        // Bug, dessen Sprint inzwischen abgeschlossen ist: Titel samt unverändertem Sprint bleibt speicherbar.
        const old = await bug(slug);
        await pool.query('UPDATE bugs SET sprint_id = $2 WHERE id = $1', [old, completed]);
        const renamed = await api.call('PATCH', `/bugs/${old}`, { title: 'Neu', sprintId: completed });
        assert.equal(renamed.status, 200);
        assert.equal((await row('bugs', old))?.title, 'Neu');
      });
    } finally {
      await api.close();
    }
  });
});
