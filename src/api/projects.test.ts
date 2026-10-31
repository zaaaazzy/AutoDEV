import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';
import { registerProjectRoutes } from './projects.js';
import { parseProductionSettings } from './project-input.js';
import { encryptProjectSecrets } from '../db/project-repository.js';
import type { Principal } from './roles.js';
import { requiredRole } from './route-table.test.js';
import { serveRoutes } from './serve-routes.test.js';
import { decryptSecret, isEncrypted } from '../core/secrets.js';
import { withMigratedDatabase } from '../db/test-database.test.js';

const admin: Principal = { id: null, username: 'admin', displayName: 'Admin', roles: ['admin'] };
const KEY = 'projekt-test-schluessel-0123456789';

test('Projekte anlegen, ändern und löschen nur mit Administration', () => {
  assert.equal(requiredRole('POST', '/api/projects', {}), 'admin');
  assert.equal(requiredRole('PATCH', '/api/projects/alpha', {}), 'admin');
  assert.equal(requiredRole('DELETE', '/api/projects/alpha', {}), 'admin');
  assert.equal(requiredRole('POST', '/api/projects/alpha/github/check', {}), 'admin');
});

test('Produktions-Einstellungen: Dienste, Muster und Aufbewahrung werden geprüft', () => {
  assert.deepEqual(parseProductionSettings({}), []);
  assert.deepEqual(parseProductionSettings({ logServices: 'api, web api', productionRetentionDays: '30' }), [
    ['log_services', ['api', 'web']],
    ['production_retention_days', 30],
  ]);
  assert.deepEqual(parseProductionSettings({ healthUrl: null, productionIgnore: 'a\r\nb\n' }), [
    ['health_url', null],
    ['production_ignore', ['a', 'b']],
  ]);
  assert.match(String(parseProductionSettings({ healthUrl: 42 })), /Health-URL/);
  assert.match(String(parseProductionSettings({ logServices: 'api; rm -rf' })), /Log-Dienste/);
  assert.match(String(parseProductionSettings({ logServices: Array(21).fill('a') })), /Log-Dienste/);
  assert.match(String(parseProductionSettings({ productionIgnore: ['x'.repeat(201)] })), /Ausschlussmuster/);
  for (const days of [0, 366, 1.5, 'viel'])
    assert.match(String(parseProductionSettings({ productionRetentionDays: days })), /1 bis 365/);
});

test('Projekte auf PostgreSQL: anlegen, Einstellungen, Mandantentrennung, löschen', async (t) => {
  await withMigratedDatabase(t, 'devlog_projects', async (db) => {
    const pool = db as unknown as Pool;
    const previousKey = process.env.DEV_LOG_SECRET_KEY;
    process.env.DEV_LOG_SECRET_KEY = KEY;
    const api = await serveRoutes(admin, (router) => registerProjectRoutes(router, pool));
    try {
      await t.test('anlegen: Eingaben geprüft, Standard-Agents angelegt, ID nicht überschreibbar', async () => {
        const valid = { name: 'Alpha', slug: 'Alpha Projekt', repository: '/srv/projekte/alpha' };
        const rejected: [unknown, RegExp][] = [
          [{ ...valid, name: '' }, /Projektnamen/],
          [{ ...valid, slug: '' }, /Projekt-ID/],
          [{ ...valid, repository: '' }, /Projektordner/],
          [{ ...valid, repository: 'relativ/pfad' }, /absoluter Pfad/],
          [{ ...valid, repository: '/srv/../etc' }, /"\."/],
          [{ ...valid, repository: '/etc/alpha' }, /./],
          [{ ...valid, repository: '/Users/ana' }, /./],
          [[], /Ungültige Anfrage/],
        ];
        for (const [body, message] of rejected) {
          const response = await api.call('POST', '/projects', body);
          assert.equal(response.status, 400, JSON.stringify(body));
          assert.match(response.body.message, message);
        }
        const created = await api.call('POST', '/projects', valid);
        assert.equal(created.status, 201);
        assert.equal(created.body.project.slug, 'alpha-projekt', 'ID wird normalisiert');
        const agents = await pool.query(`SELECT role FROM agents WHERE project_slug = 'alpha-projekt'`);
        assert.ok(agents.rowCount! > 0, 'Standard-Agents angelegt');

        const taken = await api.call('POST', '/projects', { ...valid, name: 'Andere', repository: '/srv/anders' });
        assert.equal(taken.status, 409);
        const row = (await pool.query(`SELECT name, repository FROM projects WHERE slug = 'alpha-projekt'`)).rows[0];
        assert.deepEqual(row, { name: 'Alpha', repository: '/srv/projekte/alpha' }, 'nichts überschrieben');
        assert.equal((await api.call('POST', '/projects', { ...valid, slug: 'beta', name: 'Beta' })).status, 201);
      });

      await t.test('Liste: nur freigeschaltete Projekte, Datenbank-Zugang nur als Ja/Nein', async () => {
        const all = await api.call('GET', '/projects');
        assert.deepEqual(
          all.body.projects.map((project: { slug: string }) => project.slug),
          ['alpha-projekt', 'beta'],
        );
        assert.ok(all.body.projects.every((project: Record<string, unknown>) => !('databaseUrl' in project)));
        const member = await serveRoutes(admin, (router) => registerProjectRoutes(router, pool), {
          allowedProjects: new Set(['beta']),
        });
        try {
          const visible = await member.call('GET', '/projects');
          assert.deepEqual(
            visible.body.projects.map((project: { slug: string }) => project.slug),
            ['beta'],
          );
        } finally {
          await member.close();
        }
      });

      await t.test('ändern: Eingaben werden geprüft, ungültige Änderungen speichern nichts', async () => {
        const rejected: [Record<string, unknown>, RegExp][] = [
          [{}, /Keine Änderung/],
          [{ gitRemote: 'https://user:pw@github.com/a/b.git' }, /Repository-URL/],
          [{ gitRemote: 42 }, /Repository-URL/],
          [{ databaseUrl: 'mysql://x' }, /Datenbank-Zugang/],
          [{ databaseUrl: 'postgresql://u:p@db:5432/aideation' }, /AIdeation-Datenbank/],
          [{ repository: '/etc' }, /./],
          [{ definitionOfDone: Array(21).fill('Punkt') }, /höchstens 20/],
          [{ testCommands: ['npm', 'test'] }, /ein Befehl pro Zeile/],
          [{ deployCommands: Array(11).fill('x').join('\n') }, /höchstens 10/],
          [{ reviewMode: 'manchmal' }, /Review-Freigabe/],
          [{ reviewUrl: 'ftp://x' }, /Review-Adresse/],
          [{ description: 'x'.repeat(10_001) }, /10000/],
          [{ sprintMode: 'chaos' }, /Sprintplanung/],
          [{ sprintCapacityHours: 0 }, /Kapazität/],
          [{ autopilotStart: '08:00' }, /Arbeitszeiten/],
          [{ autopilotStart: '25:00', autopilotEnd: '17:00', autopilotDays: [1] }, /Arbeitszeiten/],
          [{ productionRetentionDays: 0 }, /1 bis 365/],
          [{ autoBugfix: 'ja' }, /ein- oder ausgeschaltet/],
          [{ githubMode: 'alles' }, /GitHub-Brücke/],
          [{ githubMode: 'issues' }, /braucht ein GitHub-Repository/],
          [{ githubMode: 'issues', gitRemote: 'git@gitlab.com:a/b.git' }, /./],
        ];
        for (const [body, message] of rejected) {
          const response = await api.call('PATCH', '/projects/alpha-projekt', body);
          assert.equal(response.status, 400, JSON.stringify(body));
          assert.match(response.body.message, message);
        }
        const row = (await pool.query(`SELECT git_remote, github_mode FROM projects WHERE slug = 'alpha-projekt'`))
          .rows[0];
        assert.equal(row.git_remote, null);
        assert.equal((await api.call('PATCH', '/projects/gibt-es-nicht', { autoBugfix: true })).status, 404);
      });

      await t.test('ändern: Werte werden normalisiert gespeichert', async () => {
        const response = await api.call('PATCH', '/projects/alpha-projekt', {
          gitRemote: 'https://github.com/ana/alpha.git',
          githubMode: 'issues',
          definitionOfDone: '- Tests grün\n* Doku aktualisiert\n\n',
          testCommands: 'npm test\n\nnpm run lint  -- --fix',
          orderTestCommands: '',
          deployCommands: 'docker compose up -d',
          reviewMode: 'ui',
          sprintMode: 'autopilot',
          sprintCapacityHours: 12.5,
          autopilotStart: '08:00',
          autopilotEnd: '17:00',
          autopilotDays: [1, 2, 3],
          description: '  Shop  ',
        });
        assert.equal(response.status, 200, JSON.stringify(response.body));
        const project = response.body.project;
        assert.deepEqual(project.definitionOfDone, ['Tests grün', 'Doku aktualisiert']);
        assert.deepEqual(project.testCommands, [
          ['npm', 'test'],
          ['npm', 'run', 'lint', '--', '--fix'],
        ]);
        assert.equal(project.orderTestCommands, null);
        assert.deepEqual(project.deployCommands, [['docker', 'compose', 'up', '-d']]);
        assert.equal(project.githubMode, 'issues');
        assert.equal(project.githubAuthCheckedAt, null, 'neuer Modus wird neu geprüft');
        assert.equal(project.description, 'Shop');
        assert.equal(project.sprintCapacityHours, 12.5);
        assert.deepEqual(project.autopilotDays, [1, 2, 3]);
      });

      await t.test('Datenbank-Zugang wird verschlüsselt gespeichert und nie ausgeliefert', async () => {
        const url = 'postgresql://shop:geheim@db:5432/shop';
        const response = await api.call('PATCH', '/projects/alpha-projekt', { databaseUrl: url });
        assert.equal(response.body.project.databaseConfigured, true);
        assert.doesNotMatch(JSON.stringify(response.body), /geheim/);
        const stored = (await pool.query(`SELECT database_url FROM projects WHERE slug = 'alpha-projekt'`)).rows[0]
          .database_url as string;
        assert.ok(isEncrypted(stored));
        assert.equal(decryptSecret(stored), url);

        // Altbestand im Klartext wird beim Start einmal verschlüsselt.
        await pool.query(`UPDATE projects SET database_url = 'postgresql://alt:pw@db/alt' WHERE slug = 'beta'`);
        assert.equal(await encryptProjectSecrets(pool), 1);
        assert.equal(await encryptProjectSecrets(pool), 0);
        const beta = (await pool.query(`SELECT database_url FROM projects WHERE slug = 'beta'`)).rows[0];
        assert.ok(isEncrypted(beta.database_url));

        const cleared = await api.call('PATCH', '/projects/alpha-projekt', { databaseUrl: '' });
        assert.equal(cleared.body.project.databaseConfigured, false);
      });

      await t.test('Favicon mit strenger CSP, Git-Graph leer ohne Daten', async () => {
        assert.equal((await api.call('GET', '/projects/beta/favicon')).status, 404);
        const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
        await pool.query(`UPDATE projects SET favicon = $1, favicon_type = 'image/svg+xml' WHERE slug = 'beta'`, [svg]);
        const icon = await api.call('GET', '/projects/beta/favicon');
        assert.equal(icon.status, 200);
        assert.equal(icon.headers.get('content-type'), 'image/svg+xml');
        assert.match(icon.headers.get('content-security-policy') ?? '', /default-src 'none'.*sandbox/);
        assert.equal(icon.headers.get('x-content-type-options'), 'nosniff');
        assert.deepEqual(icon.raw, svg);
        assert.deepEqual((await api.call('GET', '/projects/beta/git-graph')).body, { graph: null, updatedAt: null });
      });

      await t.test('GitHub-Anmeldung neu prüfen setzt den Prüfzeitpunkt zurück', async () => {
        await pool.query(`UPDATE projects SET github_auth_checked_at = NOW() WHERE slug = 'alpha-projekt'`);
        const response = await api.call('POST', '/projects/alpha-projekt/github/check');
        assert.equal(response.status, 200);
        assert.equal(response.body.github.githubAuthCheckedAt, null);
        assert.equal((await api.call('POST', '/projects/gibt-es-nicht/github/check')).status, 404);
      });

      await t.test('löschen: nur mit Namen, nicht während ein Agent arbeitet, Ordner auf Wunsch', async () => {
        assert.equal((await api.call('DELETE', '/projects/beta', { confirm: 'beta' })).status, 400);
        assert.equal((await api.call('DELETE', '/projects/gibt-es-nicht', { confirm: 'x' })).status, 404);

        const order = (
          await pool.query<{ id: string }>(
            `INSERT INTO development_items (project_slug, title) VALUES ('beta', 'Auftrag') RETURNING id`,
          )
        ).rows[0]!.id;
        await pool.query(
          `INSERT INTO agent_runs (project_slug, development_id, status) VALUES ('beta', $1, 'running')`,
          [order],
        );
        assert.equal((await api.call('DELETE', '/projects/beta', { confirm: 'Beta' })).status, 409);
        await pool.query(`UPDATE agent_runs SET status = 'passed'`);

        const deleted = await api.call('DELETE', '/projects/beta', { confirm: ' Beta ', deleteFolder: true });
        assert.equal(deleted.status, 200);
        assert.equal(deleted.body.deleted, true);
        const job = (await pool.query('SELECT kind, params FROM setup_jobs WHERE id = $1', [deleted.body.folderJob]))
          .rows[0];
        // beta wurde mit demselben Ordner wie alpha angelegt (siehe oben).
        assert.deepEqual(job, { kind: 'delete_folder', params: { path: '/srv/projekte/alpha' } });
        assert.equal((await pool.query(`SELECT 1 FROM projects WHERE slug = 'beta'`)).rowCount, 0);
        assert.equal((await pool.query('SELECT 1 FROM development_items WHERE id = $1', [order])).rowCount, 0);
      });
    } finally {
      await api.close();
      if (previousKey === undefined) delete process.env.DEV_LOG_SECRET_KEY;
      else process.env.DEV_LOG_SECRET_KEY = previousKey;
    }
  });
});
