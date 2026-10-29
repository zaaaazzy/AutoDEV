import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';
import type { Principal } from './roles.js';
import { serveRoutes } from './serve-routes.test.js';
import { registerSetupRoutes } from './setup.js';
import { withMigratedDatabase } from '../db/test-database.test.js';
import { PHASER_DEV_URL } from '../setup/templates.js';

// Unabhängig vom Projektbereich der Umgebung (der Worker setzt ihn, z. B. im Test-Gate).
delete process.env.DEV_LOG_PROJECT_ROOTS;

const admin: Principal = { id: null, username: 'admin', displayName: 'Admin', roles: ['admin'] };

test('Projekt-Assistent auf PostgreSQL: Vorlage belegt die Projekt-Einstellungen vor', async (t) => {
  await withMigratedDatabase(t, 'devlog_setup_template', async (db) => {
    const pool = db as unknown as Pool;
    const api = await serveRoutes(admin, (router) => registerSetupRoutes(router, pool));
    try {
      const listed = await api.call('GET', '/setup/templates');
      const phaser = listed.body.templates.find((entry: { id: string }) => entry.id === 'phaser-game');
      assert.equal(phaser.project.previewUrl, PHASER_DEV_URL, 'Vorbelegung für den Hinweis im Assistenten');
      assert.equal(phaser.files, undefined);

      const base = { agent: { provider: 'ollama' } };
      const game = await api.call('POST', '/projects/setup', {
        ...base,
        name: 'Sternenjagd',
        slug: 'sternenjagd',
        repository: '/srv/projekte/sternenjagd',
        template: 'phaser-game',
      });
      assert.equal(game.status, 201, JSON.stringify(game.body));
      const row = (
        await pool.query(
          `SELECT test_commands, order_test_commands, review_command, preview_url, guidelines FROM projects WHERE slug = 'sternenjagd'`,
        )
      ).rows[0];
      assert.deepEqual(row.test_commands, [
        ['npm', 'run', 'build'],
        ['npm', 'test'],
        ['npm', 'run', 'test:smoke'],
      ]);
      assert.deepEqual(row.order_test_commands[1], ['npx', 'vitest', 'run', '{tests}']);
      assert.deepEqual(row.review_command, ['npm', 'run', 'review']);
      assert.equal(row.preview_url, PHASER_DEV_URL);
      assert.match(row.guidelines, /Phaser 3/);

      // Ohne Vorlage (oder mit unbekannter) bleibt alles wie bisher leer.
      for (const [slug, template] of [
        ['ohne', undefined],
        ['fremd', 'gibt-es-nicht'],
      ] as const) {
        const created = await api.call('POST', '/projects/setup', {
          ...base,
          name: slug,
          slug,
          repository: `/srv/projekte/${slug}`,
          ...(template ? { template } : {}),
        });
        assert.equal(created.status, 201);
        const plain = (
          await pool.query(`SELECT test_commands, review_command, preview_url FROM projects WHERE slug = $1`, [slug])
        ).rows[0];
        assert.deepEqual(plain, { test_commands: null, review_command: null, preview_url: null });
      }
    } finally {
      await api.close();
    }
  });
});
