import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';
import { hashIngestToken, tokenMatches } from './ingest.js';
import { fillHistory, registerProductionRoutes } from './production.js';
import type { Principal } from './roles.js';
import { serveRoutes } from './serve-routes.test.js';
import { withMigratedDatabase } from '../db/test-database.test.js';

// Snippets nennen sonst die konfigurierte öffentliche Adresse statt die des Testservers.
delete process.env.DEV_LOG_PUBLIC_URL;
delete process.env.DEV_LOG_DOMAIN;

const admin: Principal = { id: null, username: 'admin', displayName: 'Admin', roles: ['admin'] };

test('Verlauf: 48 Stunden lückenlos, älteste zuerst, Zählungen auf die volle Stunde', () => {
  const now = new Date('2026-10-30T12:34:56Z');
  const history = fillHistory(
    [
      { hour: '2026-10-30T12:00:00Z', count: 3 },
      { hour: new Date('2026-10-30T09:00:00Z'), count: 1 },
      // Älter als das Fenster: fällt heraus.
      { hour: '2026-10-27T00:00:00Z', count: 9 },
    ],
    now,
  );
  assert.equal(history.length, 48);
  assert.equal(history[0]!.hour, '2026-10-28T13:00:00.000Z');
  assert.deepEqual(history.at(-1), { hour: '2026-10-30T12:00:00.000Z', count: 3 });
  assert.equal(history.at(-4)!.count, 1);
  assert.equal(
    history.reduce((sum, entry) => sum + entry.count, 0),
    4,
  );
  assert.deepEqual(fillHistory([], now, 2), [
    { hour: '2026-10-30T11:00:00.000Z', count: 0 },
    { hour: '2026-10-30T12:00:00.000Z', count: 0 },
  ]);
});

test('Produktions-Rückkanal auf PostgreSQL: Status, Ereignisse eines Bugs, Ingest-Token', async (t) => {
  await withMigratedDatabase(t, 'devlog_production_routes', async (db) => {
    const pool = db as unknown as Pool;
    await pool.query(`INSERT INTO projects (slug, name, repository) VALUES
      ('velo', 'Velowerk', '/srv/velo'), ('ruhig', 'Ruhig', '/srv/ruhig')`);
    const client = await serveRoutes(admin, (router) => registerProductionRoutes(router, pool));
    const status = async (slug: string) => (await client.call('GET', `/projects/${slug}/production`)).body.production;
    try {
      await t.test('Ohne Einrichtung: nicht konfiguriert, aber gesund', async () => {
        const production = await status('ruhig');
        assert.equal(production.configured, false);
        assert.equal(production.healthy, true);
        assert.equal(production.down, false);
        assert.equal(production.failures, 0);
        assert.equal(production.last24h, 0);
        assert.equal((await client.call('GET', '/projects/gibtsnicht/production')).status, 404);
        assert.equal((await client.call('GET', '/projects/Ungültig!/production')).status, 400);
      });

      await t.test('Snippets nennen den Ingest-Endpunkt mit Platzhalter, nie ein Token', async () => {
        const response = await client.call('GET', '/projects/velo/production');
        assert.equal(response.headers.get('cache-control'), 'no-store');
        const { endpoint, browser, node } = response.body.snippets;
        assert.match(endpoint, /^http:\/\/127\.0\.0\.1:\d+\/api\/ingest\/velo\/<TOKEN>$/);
        assert.ok(browser.includes(endpoint));
        assert.ok(node.includes(endpoint));
      });

      // Betriebs-Bugs und Ereignisse: zwei offene (einer kritisch), einer erledigt, Ereignisse aus Logs und Ingest.
      const bug = async (title: string, severity: string, bugStatus: string, source = 'production') =>
        (
          await pool.query<{ id: string }>(
            `INSERT INTO bugs (project_slug, title, severity, status, source) VALUES ('velo', $1, $2, $3, $4)
             RETURNING id`,
            [title, severity, bugStatus, source],
          )
        ).rows[0]!.id;
      const critical = await bug('Absturz beim Login', 'critical', 'open');
      await bug('Langsame Suche', 'medium', 'in_progress');
      await bug('Behoben', 'critical', 'fixed');
      await bug('Von Hand', 'critical', 'open', 'manual');
      const event = async (
        source: string,
        fingerprint: string,
        count: number,
        bugId: string | null,
        lastSeen: string,
      ) =>
        (
          await pool.query<{ id: string }>(
            `INSERT INTO production_events (project_slug, source, fingerprint, count, bug_id, last_seen, sample)
             VALUES ('velo', $1, $2, $3, $4, NOW() - $5::interval, '{"message":"Boom"}') RETURNING id`,
            [source, fingerprint, count, bugId, lastSeen],
          )
        ).rows[0]!.id;
      const logs = await event('logs', 'log-1', 5, critical, '10 minutes');
      const ingest = await event('ingest', 'browser-1', 2, critical, '1 hour');
      await event('logs', 'log-2', 1, null, '2 days');
      const bucket = (eventId: string, hoursAgo: number, count: number) =>
        pool.query(
          `INSERT INTO production_event_buckets (event_id, hour, count)
           VALUES ($1, date_trunc('hour', NOW()) - make_interval(hours => $2), $3)`,
          [eventId, hoursAgo, count],
        );
      await bucket(logs, 0, 3);
      await bucket(logs, 2, 2);
      await bucket(ingest, 2, 2);
      // Ausserhalb von 24 Stunden bzw. 48 Stunden.
      await bucket(logs, 30, 7);
      await bucket(logs, 60, 11);

      await t.test('Mit Ereignissen und kritischem Bug: eingerichtet, aber nicht gesund', async () => {
        await pool.query(
          `UPDATE projects SET health_url = 'https://velo.example/health', log_services = '{web}' WHERE slug = 'velo'`,
        );
        await pool.query(
          `INSERT INTO production_status (project_slug, down, failures, last_error) VALUES ('velo', FALSE, 1, 'Timeout')`,
        );
        const production = await status('velo');
        assert.deepEqual(
          {
            configured: production.configured,
            logsConfigured: production.logsConfigured,
            ingestConfigured: production.ingestConfigured,
            healthy: production.healthy,
            openBugs: production.openBugs,
            criticalBugs: production.criticalBugs,
            logEvents: production.logEvents,
            logOccurrences: production.logOccurrences,
            last24h: production.last24h,
            failures: production.failures,
            lastError: production.lastError,
          },
          {
            configured: true,
            logsConfigured: true,
            ingestConfigured: false,
            healthy: false,
            openBugs: 2,
            criticalBugs: 1,
            logEvents: 2,
            logOccurrences: 6,
            last24h: 7,
            failures: 1,
            lastError: 'Timeout',
          },
        );
        // Ohne offenen kritischen Bug, aber Health-Check ausgefallen: ebenfalls nicht gesund.
        await pool.query(`UPDATE bugs SET status = 'fixed' WHERE id = $1`, [critical]);
        await pool.query(`UPDATE production_status SET down = TRUE`);
        const down = await status('velo');
        assert.deepEqual([down.criticalBugs, down.down, down.healthy], [0, true, false]);
        await pool.query(`UPDATE production_status SET down = FALSE`);
        assert.equal((await status('velo')).healthy, true);
      });

      await t.test('Ereignisse eines Bugs: neueste zuerst, Verlauf der letzten 48 Stunden', async () => {
        assert.equal((await client.call('GET', '/bugs/kein-uuid/production')).status, 404);
        const response = await client.call('GET', `/bugs/${critical}/production`);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.deepEqual(
          response.body.events.map((entry: { fingerprint: string; count: number }) => [entry.fingerprint, entry.count]),
          [
            ['log-1', 5],
            ['browser-1', 2],
          ],
        );
        const history = response.body.history as { hour: string; count: number }[];
        assert.equal(history.length, 48);
        assert.equal(history.at(-1)!.count, 3);
        assert.equal(history.at(-3)!.count, 4, 'beide Ereignisse derselben Stunde zusammengezählt');
        assert.equal(
          history.reduce((sum, entry) => sum + entry.count, 0),
          14,
          'nur was im Fenster liegt (60 Stunden alt fällt heraus)',
        );
        const unknown = await client.call('GET', '/bugs/00000000-0000-4000-8000-000000000000/production');
        assert.deepEqual(unknown.body.events, []);
        assert.equal(unknown.body.history.length, 48);
      });

      await t.test(
        'Ingest-Token: einmal im Klartext, gespeichert nur der Hash, Rotieren macht das alte ungültig',
        async () => {
          assert.equal((await client.call('POST', '/projects/gibtsnicht/ingest-token')).status, 404);
          const first = await client.call('POST', '/projects/velo/ingest-token');
          assert.equal(first.status, 201);
          assert.equal(first.headers.get('cache-control'), 'no-store');
          const token = first.body.token as string;
          assert.ok(first.body.endpoint.endsWith(`/api/ingest/velo/${token}`));
          const stored = async () =>
            (
              await pool.query<{ hash: string | null }>(
                `SELECT ingest_token_hash AS hash FROM projects WHERE slug = 'velo'`,
              )
            ).rows[0]!.hash;
          assert.equal(await stored(), hashIngestToken(token));
          assert.ok(!(await stored())!.includes(token));
          assert.ok(tokenMatches(token, await stored()));
          assert.equal((await status('velo')).ingestConfigured, true);
          // Die Statusseite gibt das Token nie wieder heraus.
          assert.ok(!JSON.stringify((await client.call('GET', '/projects/velo/production')).body).includes(token));

          const second = (await client.call('POST', '/projects/velo/ingest-token')).body.token as string;
          assert.notEqual(second, token);
          assert.equal(tokenMatches(token, await stored()), false, 'altes Token gilt nach dem Rotieren nicht mehr');
          assert.ok(tokenMatches(second, await stored()));

          assert.equal((await client.call('DELETE', '/projects/velo/ingest-token')).status, 204);
          assert.equal(await stored(), null);
          assert.equal(tokenMatches(second, await stored()), false);
          assert.equal((await status('velo')).ingestConfigured, false);
          // Das andere Projekt bleibt unberührt.
          assert.equal(
            (await pool.query(`SELECT ingest_token_hash FROM projects WHERE slug = 'ruhig'`)).rows[0].ingest_token_hash,
            null,
          );
        },
      );
    } finally {
      await client.close();
    }
  });
});
