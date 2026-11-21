import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';
import { dependencyAllowed, findOrderByTitle, setDependency } from '../db/development-repository.js';
import { withMigratedDatabase } from '../db/test-database.test.js';
import { selectItems } from './runner-selection.js';

const options = { project: 'alpha', cwd: '/tmp', limit: 10 } as Parameters<typeof selectItems>[1];

async function order(db: Pool, title: string, fields: Record<string, unknown> = {}): Promise<string> {
  const columns = Object.keys(fields);
  return (
    await db.query<{ id: string }>(
      `INSERT INTO development_items (project_slug, title, status, auto_run${columns.map((column) => `, ${column}`).join('')})
       VALUES ('alpha', $1, 'planned', TRUE${columns.map((_, index) => `, $${index + 2}`).join('')}) RETURNING id`,
      [title, ...Object.values(fields)],
    )
  ).rows[0]!.id;
}

test('Abhängigkeiten auf PostgreSQL: Auswahl, Auflösen nach Titel, Kreise', async (t) => {
  await withMigratedDatabase(t, 'devlog_dependency', async (db) => {
    await db.query(`INSERT INTO projects (slug, name, repository) VALUES ('alpha', 'Alpha', '/tmp/a')`);
    await db.query(`INSERT INTO projects (slug, name, repository) VALUES ('beta', 'Beta', '/tmp/b')`);
    const scaffold = await order(db, 'Monorepo-Grundgerüst');
    const login = await order(db, 'Spotify-Login', { depends_on: scaffold });
    const free = await order(db, 'Unabhängig');

    await t.test('ein Auftrag mit offener Abhängigkeit wird nicht gewählt, der ohne schon', async () => {
      const chosen = (await selectItems(db, options)).map((item) => item.title).sort();
      assert.deepEqual(chosen, ['Monorepo-Grundgerüst', 'Unabhängig']);
    });

    await t.test(
      'gezielter Start (--item) läuft trotz Abhängigkeit – das ist eine Entscheidung des Menschen',
      async () => {
        assert.equal((await selectItems(db, { ...options, itemId: login })).length, 1);
      },
    );

    await t.test('ist die Abhängigkeit erledigt, wird der Auftrag gewählt', async () => {
      await db.query(`UPDATE development_items SET status = 'done' WHERE id = $1`, [scaffold]);
      const chosen = (await selectItems(db, options)).map((item) => item.title).sort();
      assert.deepEqual(chosen, ['Spotify-Login', 'Unabhängig']);
    });

    await t.test(
      'findOrderByTitle: ohne Gross-/Kleinschreibung und Anführungszeichen, nie der eigene Auftrag',
      async () => {
        assert.equal(await findOrderByTitle(db, 'alpha', '„monorepo-grundgerüst“'), scaffold);
        assert.equal(await findOrderByTitle(db, 'alpha', 'Monorepo-Grundgerüst ', scaffold), null);
        assert.equal(await findOrderByTitle(db, 'beta', 'Monorepo-Grundgerüst'), null, 'anderes Projekt');
        assert.equal(await findOrderByTitle(db, 'alpha', 'Gibt es nicht'), null);
      },
    );

    await t.test('dependencyAllowed: selbst, fremdes Projekt und Kreise sind verboten', async () => {
      const foreign = (
        await db.query<{ id: string }>(
          `INSERT INTO development_items (project_slug, title) VALUES ('beta', 'Fremd') RETURNING id`,
        )
      ).rows[0]!.id;
      assert.equal(await dependencyAllowed(db, free, scaffold), true);
      assert.equal(await dependencyAllowed(db, free, free), false, 'nicht von sich selbst');
      assert.equal(await dependencyAllowed(db, free, foreign), false, 'nicht aus einem anderen Projekt');
      // login → scaffold; scaffold → login wäre ein Kreis.
      assert.equal(await dependencyAllowed(db, scaffold, login), false, 'Kreis über eine Stufe');
      assert.equal(await setDependency(db, free, login), true);
      assert.equal(await dependencyAllowed(db, scaffold, free), false, 'Kreis über zwei Stufen');
      assert.equal(await setDependency(db, scaffold, free), false);
      assert.equal(await setDependency(db, free, null), true, 'Abhängigkeit löschen');
    });

    await t.test('wird der Auftrag gelöscht, von dem ein anderer abhängt, fällt die Abhängigkeit weg', async () => {
      const gone = await order(db, 'Verschwindet');
      await setDependency(db, free, gone);
      await db.query(`DELETE FROM development_items WHERE id = $1`, [gone]);
      const row = (
        await db.query<{ depends_on: string | null }>(`SELECT depends_on FROM development_items WHERE id = $1`, [free])
      ).rows[0];
      assert.equal(row?.depends_on, null);
    });
  });
});
