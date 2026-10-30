import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import type { Pool } from 'pg';
import { AREA_RULES, BUG_CATEGORY_VALUES, bugCategorySql, categorizeBug, PRIORITY_RULES } from './bug-category.js';
import { caseBugs, fileBugs, stepBug } from './test-bugs.js';
import { MIGRATIONS, runMigrations } from '../db/migrations.js';
import { adminPool, databaseUrl, dropDatabase } from '../db/test-database.test.js';
import { registerBugRoutes, reportAgentBug } from '../api/bugs.js';
import { serveRoutes } from '../api/serve-routes.test.js';
import type { Principal } from '../api/roles.js';
import { bugCategoryFor } from '../runner/production-events.js';

const admin: Principal = { id: null, username: 'admin', displayName: 'Admin', roles: ['admin'] };

/** Beispiele, an denen Regel (TypeScript) und Migration (SQL) übereinstimmen müssen. */
const SAMPLES: [title: string, description: string, expected: string | null][] = [
  ['Sprint-Abschluss hängt', 'Fehler in `src/runner/git-sync/sprint-reviews.ts:48`', 'git-sync'],
  ['Push-Abos', 'SSRF über die Endpunkt-Adresse in src/api/push.ts', 'security'],
  ['Agent-Ausführung', 'RCE möglich, wenn der Befehl in frontend/src/app/x.ts landet', 'security'],
  ['Halbfertige Änderungen', 'Landen im WIP-Commit eines anderen Auftrags (fremder Worktree).', 'git-sync'],
  ['Oberflächentest: Projektwechsel (Handy)', 'Der Oberflächentest **Projektwechsel** ist rot.', 'frontend'],
  ['CI-Lauf 123 fehlgeschlagen', '', 'ci'],
  ['Lebenszeichen fehlt', 'Der Worker schreibt kein Lebenszeichen.', 'runner'],
  ['Handbuch veraltet', 'Im Benutzerhandbuch fehlt der Abschnitt.', 'docs'],
  ['Liste', 'Fehler in `frontend/src/app/list.ts` und src/api/list.ts', 'fullstack'],
  ['Liste lädt nicht', 'Antwort von src/api/list.ts ist 500.', 'backend'],
  ['Postgres voll', 'Der Container hat keinen Platz mehr.', 'infrastructure'],
  ['Komisch', 'Irgendetwas stimmt nicht.', null],
  // Wortgrenzen: „ci“ in „special“, „ui“ in „Quittung“, „api“ in „Kapitel“ sind keine Treffer.
  ['Special Quittung', 'Kapitel drei, Decision.', null],
];

test('Bug-Kategorie: Pfad src/runner/git-sync/… ergibt git-sync', () => {
  assert.equal(
    categorizeBug({ title: 'Merge scheitert', description: 'Siehe src/runner/git-sync/merge.ts Zeile 12' }),
    'git-sync',
  );
});

test('Bug-Kategorie: Sicherheitsstichwort (SSRF, RCE) gewinnt gegen Pfade anderer Bereiche', () => {
  assert.equal(categorizeBug({ title: 'Push-Abos', description: 'SSRF in src/runner/git-sync/push.ts' }), 'security');
  assert.equal(categorizeBug({ title: 'rce im Chat', description: 'frontend/src/app/chat.ts' }), 'security');
});

test('Bug-Kategorie: ohne Pfad- oder Stichworttreffer null (nicht raten)', () => {
  assert.equal(categorizeBug({ title: 'Etwas ist kaputt', description: 'Bitte ansehen.' }), null);
  assert.equal(categorizeBug({ title: '' }), null);
});

test('Bug-Kategorie: Bereichs-Rückfall – einer gilt, mehrere ergeben Fullstack; Quelle zählt mit', () => {
  assert.equal(categorizeBug({ title: 'Knopf verrutscht', description: 'Layout auf dem Handy' }), 'frontend');
  assert.equal(categorizeBug({ title: 'Absturz', source: 'postgres' }), 'infrastructure');
  assert.equal(categorizeBug({ title: 'UI zeigt Fehler der API' }), 'fullstack');
});

test('Bug-Kategorie: Regeltabelle in Prioritätsreihenfolge, nur Werte der festen Liste', () => {
  assert.deepEqual(
    PRIORITY_RULES.map((rule) => rule.category),
    ['security', 'git-sync', 'ci', 'runner', 'docs'],
  );
  assert.deepEqual(
    AREA_RULES.map((rule) => rule.category),
    ['frontend', 'backend', 'infrastructure'],
  );
  for (const rule of [...PRIORITY_RULES, ...AREA_RULES]) assert.ok(BUG_CATEGORY_VALUES.includes(rule.category));
  for (const [title, description, expected] of SAMPLES) {
    assert.equal(categorizeBug({ title, description }), expected, title);
  }
});

test('Bug-Kategorie: Tester-Bugs (Oberflächentest Desktop/Handy, Komplettlauf) bekommen die Kategorie beim Anlegen', async () => {
  const drafts = [
    ...caseBugs(
      [
        {
          category: 'user',
          title: 'Projektwechsel trennt die Daten',
          file: 'e2e/full-ui.check.ts',
          device: 'desktop',
          status: 'failed',
          errors: ['Erwartet: leer'],
          media: [],
        } as never,
      ],
      'run-1',
    ),
    stepBug('npm run lint', 'src/runner/git-sync/merge.ts: unused variable', 'run-1'),
  ];
  const values: unknown[][] = [];
  const pool = {
    query: async (sql: string, params: unknown[]) => {
      assert.match(sql, /INSERT INTO bugs .*category/s);
      values.push(params);
      return { rowCount: 1, rows: [] };
    },
  } as unknown as Pool;
  assert.equal(await fileBugs(pool, 'shop', drafts), 2);
  assert.deepEqual(
    values.map((params) => params.at(-1)),
    ['frontend', 'git-sync'],
  );
});

test('Bug-Kategorie: Betrieb – categoryFor bleibt für Infrastruktur, Frontend und Backend, Sicherheit hat Vorrang', () => {
  assert.equal(bugCategoryFor({ source: 'health', message: 'SSRF' }), 'infrastructure');
  assert.equal(bugCategoryFor({ source: 'logs', message: 'x', origin: 'postgres' }), 'infrastructure');
  assert.equal(bugCategoryFor({ source: 'logs', message: 'x', origin: 'web' }), 'frontend');
  assert.equal(bugCategoryFor({ source: 'logs', message: 'ERROR db timeout', origin: 'api' }), 'backend');
  assert.equal(bugCategoryFor({ source: 'ingest', message: 'Blocked SSRF attempt', origin: 'api' }), 'security');
});

test('Bug-Kategorie auf PostgreSQL: Migration 19, Constraints, gleiche Regel in SQL, Anlegen über API', async (t) => {
  const adminDb = await adminPool(t);
  if (!adminDb) return;
  const name = `devlog_bugcat_${process.pid}`;
  await dropDatabase(adminDb, name);
  await adminDb.query(`CREATE DATABASE ${name}`);
  const db = new pg.Pool({ connectionString: databaseUrl(name), max: 2 });
  try {
    // Stand vor diesem Auftrag: alle Schritte bis 18, mit Altbestand.
    const before = MIGRATIONS.filter((migration) => migration.version < 19);
    assert.deepEqual(await runMigrations(db, before), before.map((migration) => migration.version));
    await db.query(`INSERT INTO projects (slug, name, repository) VALUES ('shop', 'Shop', '/tmp/shop')`);
    const insertBug = async (title: string, description: string, category: string | null = null) =>
      (
        await db.query<{ id: string }>(
          `INSERT INTO bugs (project_slug, title, description, category) VALUES ('shop', $1, $2, $3) RETURNING id`,
          [title, description, category],
        )
      ).rows[0]!.id;
    const gitSync = await insertBug('Worktree', 'WIP-Commit landet im fremden Auftrag');
    const manual = await insertBug('SSRF', 'gefunden in src/runner/git-sync/x.ts', 'docs');
    const unknown = await insertBug('Komisch', 'Irgendetwas');
    const withOrder = await insertBug('Sprint-Tag fehlt', 'nach dem Merge');
    const order = (
      await db.query<{ id: string; category: string | null }>(
        `INSERT INTO development_items (project_slug, title, kind, bug_id) VALUES ('shop', 'Bug: Sprint-Tag', 'bug', $1)
         RETURNING id, category`,
        [withOrder],
      )
    ).rows[0]!;
    assert.equal(order.category, null);

    assert.deepEqual(await runMigrations(db), [19]);
    const category = async (id: string) =>
      (await db.query<{ category: string | null }>('SELECT category FROM bugs WHERE id = $1', [id])).rows[0]!.category;
    assert.equal(await category(gitSync), 'git-sync');
    assert.equal(await category(manual), 'docs', 'gesetzte Kategorie bleibt');
    assert.equal(await category(unknown), null);
    assert.equal(await category(withOrder), 'git-sync');
    const orderCategory = (
      await db.query<{ category: string | null }>('SELECT category FROM development_items WHERE id = $1', [order.id])
    ).rows[0]!.category;
    assert.equal(orderCategory, null, 'Aufträge werden nicht nachkategorisiert');

    // Zweiter Lauf: nichts mehr auszuführen; auch der Schritt selbst ändert keine Zeile mehr.
    assert.deepEqual(await runMigrations(db), []);
    await db.query('UPDATE bugs SET category = NULL WHERE id = $1', [gitSync]);
    assert.deepEqual(await runMigrations(db), []);
    assert.equal(await category(gitSync), null, 'von Hand geleerte Kategorie bleibt leer');
    const step = MIGRATIONS.find((migration) => migration.version === 19)!.sql;
    const update = step.slice(step.indexOf('UPDATE bugs'));
    await db.query('UPDATE bugs SET category = $2 WHERE id = $1', [gitSync, 'git-sync']);
    assert.equal((await db.query(update)).rowCount, 0);

    // Constraints: neue Werte für Bugs und Aufträge, unbekannte weiter abgelehnt; Ideen unverändert.
    for (const value of BUG_CATEGORY_VALUES) {
      await db.query('UPDATE bugs SET category = $2 WHERE id = $1', [unknown, value]);
      await db.query('UPDATE development_items SET category = $2 WHERE id = $1', [order.id, value]);
    }
    await assert.rejects(db.query('UPDATE bugs SET category = $2 WHERE id = $1', [unknown, 'api']), /bugs_category_check/);
    await assert.rejects(
      db.query('UPDATE development_items SET category = $2 WHERE id = $1', [order.id, 'quatsch']),
      /development_items_category_check/,
    );
    await assert.rejects(
      db.query(`INSERT INTO ideation_items (project_slug, title, category) VALUES ('shop', 'Idee', 'ci')`),
      /ideation_items_category_check/,
    );
    // Neuer Auftrag aus einem Bug erbt die neue Kategorie (Trigger development_items_inherit_category).
    const ciBug = await insertBug('CI rot', '', 'ci');
    const inherited = await db.query<{ category: string }>(
      `INSERT INTO development_items (project_slug, title, kind, bug_id) VALUES ('shop', 'Bug: CI', 'bug', $1) RETURNING category`,
      [ciBug],
    );
    assert.equal(inherited.rows[0]!.category, 'ci');

    // Dieselbe Regel in SQL wie in TypeScript.
    for (const [title, description, expected] of SAMPLES) {
      const result = await db.query<{ category: string | null }>(
        `SELECT ${bugCategorySql('t')} AS category FROM (SELECT lower($1::text || E'\\n' || $2::text) AS t) x`,
        [title, description],
      );
      assert.equal(result.rows[0]!.category, expected, title);
    }

    // reportAgentBug: Kategorie nach der Regel.
    const agentBug = await reportAgentBug(db, {
      projectSlug: 'shop',
      title: 'Entwickler: Sprint-Abschluss',
      description: 'Abbruch in src/runner/git-sync/sprint-sync.ts',
    });
    assert.equal(await category(agentBug), 'git-sync');

    // Formular: gewählte Kategorie bleibt, ohne Auswahl setzt die Regel sie.
    const api = await serveRoutes(admin, (router) => registerBugRoutes(router, db));
    try {
      const chosen = await api.call('POST', '/projects/shop/bugs', {
        title: 'Knopf fehlt',
        description: 'SSRF in src/api/push.ts',
        category: 'frontend',
      });
      assert.equal(chosen.status, 201);
      assert.equal(chosen.body.bug.category, 'frontend');
      const automatic = await api.call('POST', '/projects/shop/bugs', {
        title: 'Push-Abos',
        description: 'SSRF in src/api/push.ts',
        category: '',
      });
      assert.equal(automatic.body.bug.category, 'security');
      const none = await api.call('POST', '/projects/shop/bugs', { title: 'Etwas', description: 'Bitte ansehen.' });
      assert.equal(none.body.bug.category, null);
      assert.equal((await api.call('POST', '/projects/shop/bugs', { title: 'X', category: 'api' })).status, 400);
      const id = none.body.bug.id as string;
      assert.equal((await api.call('PATCH', `/bugs/${id}`, { category: 'runner' })).status, 200);
      assert.equal(await category(id), 'runner');
    } finally {
      await api.close();
    }
  } finally {
    await db.end();
    await dropDatabase(adminDb, name);
    await adminDb.end();
  }
});
