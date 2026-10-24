import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';
import { registerPermissionGroupRoutes, validAgentCommands } from './permission-groups.js';
import type { Principal } from './roles.js';
import { requiredRole } from './route-table.test.js';
import { serveRoutes } from './serve-routes.test.js';
import { withMigratedDatabase } from '../db/test-database.test.js';

const admin: Principal = { id: null, username: 'admin', displayName: 'Admin', roles: ['admin'] };

test('Eigene Rechte-Kategorien ändert nur die Administration', () => {
  assert.equal(requiredRole('POST', '/api/projects/alpha/permission-groups', {}), 'admin');
  assert.equal(requiredRole('PATCH', '/api/projects/alpha/permission-groups/x-build', {}), 'admin');
  assert.equal(requiredRole('DELETE', '/api/projects/alpha/permission-groups/x-build', {}), 'admin');
});

test('Rechte-Kategorien auf PostgreSQL: anlegen, prüfen, je Projekt getrennt, löschen räumt Agents auf', async (t) => {
  await withMigratedDatabase(t, 'devlog_permission_groups', async (db) => {
    const pool = db as unknown as Pool;
    await pool.query(
      `INSERT INTO projects (slug, name, repository) VALUES ('alpha', 'Alpha', '/tmp/a'), ('beta', 'Beta', '/tmp/b')`,
    );
    const api = await serveRoutes(admin, (router) => registerPermissionGroupRoutes(router, pool));
    const groups = async (slug: string) =>
      (await api.call('GET', `/projects/${slug}/permission-groups`)).body.groups as {
        id: string;
        builtIn: boolean;
        rules: string[];
        commands: { rule: string; label: string }[];
      }[];
    try {
      await t.test('anlegen: Eingaben werden geprüft', async () => {
        const rejected: [unknown, RegExp][] = [
          [{ label: '', rules: ['Bash(make test)'] }, /Name der Kategorie/],
          [{ label: 'x'.repeat(81), rules: ['Bash(make test)'] }, /Name der Kategorie/],
          [{ label: 'Build', rules: [] }, /1–30/],
          [{ label: 'Build', rules: Array.from({ length: 31 }, (_, i) => `Bash(make t${i})`) }, /1–30/],
          [{ label: 'Build', rules: [42] }, /einer pro Zeile/],
          [{ label: 'Build', rules: ['WebFetch(domain:example.com)'] }, /erlaubt sind Bash/],
          [{ label: 'Build', rules: ['Bash(make test; rm -rf /)'] }, /Shell-Sonderzeichen/],
          [[], /Ungültige Gruppe/],
        ];
        for (const [body, message] of rejected) {
          const response = await api.call('POST', '/projects/alpha/permission-groups', body);
          assert.equal(response.status, 400, JSON.stringify(body));
          assert.match(response.body.message, message);
        }
        assert.equal((await pool.query('SELECT 1 FROM project_permission_groups')).rowCount, 0);
      });

      await t.test('anlegen: Befehle als Zeilen, doppelte zusammengefasst, Name eindeutig je Projekt', async () => {
        const created = await api.call('POST', '/projects/alpha/permission-groups', {
          label: ' Build Tools ',
          description: 'Bauen',
          rules: 'Bash(make test)\n\nBash(make test)\n Bash(npm run lint:*) ',
        });
        assert.equal(created.status, 201);
        assert.deepEqual(created.body.group, {
          id: 'x-build-tools',
          label: 'Build Tools',
          description: 'Bauen',
          rules: ['Bash(make test)', 'Bash(npm run lint:*)'],
          builtIn: false,
          available: true,
        });
        const duplicate = await api.call('POST', '/projects/alpha/permission-groups', {
          label: 'Build Tools',
          rules: ['Bash(make test)'],
        });
        assert.equal(duplicate.status, 409);
        const unknown = await api.call('POST', '/projects/gibt-es-nicht/permission-groups', {
          label: 'Build Tools',
          rules: ['Bash(make test)'],
        });
        assert.equal(unknown.status, 404);
        const second = await api.call('POST', '/projects/alpha/permission-groups', {
          label: 'Checks',
          rules: ['Bash(make test)', 'Bash(make check)'],
        });
        assert.equal(second.status, 201);
      });

      await t.test('Liste: eingebaute und eigene Kategorien, eigene nur im eigenen Projekt', async () => {
        const alpha = await groups('alpha');
        assert.ok(alpha.some((group) => group.builtIn));
        assert.deepEqual(
          alpha.filter((group) => !group.builtIn).map((group) => group.id),
          ['x-build-tools', 'x-checks'],
        );
        const build = alpha.find((group) => group.id === 'x-build-tools')!;
        assert.deepEqual(
          build.commands.map((command) => command.rule),
          build.rules,
        );
        assert.ok(build.commands.every((command) => command.label));
        assert.deepEqual(
          (await groups('beta')).filter((group) => !group.builtIn),
          [],
          'Mandantentrennung',
        );
        assert.equal((await api.call('GET', '/projects/UNGÜLTIG/permission-groups')).status, 404);
      });

      await t.test('ändern: nur bestehende eigene Kategorien des Projekts', async () => {
        const changed = await api.call('PATCH', '/projects/alpha/permission-groups/x-checks', {
          label: 'Checks',
          rules: ['Bash(make test)', 'Bash(make check)', 'Bash(make lint)'],
        });
        assert.equal(changed.status, 200);
        assert.deepEqual(changed.body.group.rules, ['Bash(make test)', 'Bash(make check)', 'Bash(make lint)']);
        const body = { label: 'Checks', rules: ['Bash(make test)'] };
        assert.equal((await api.call('PATCH', '/projects/beta/permission-groups/x-checks', body)).status, 404);
        assert.equal((await api.call('PATCH', '/projects/alpha/permission-groups/x-fehlt', body)).status, 404);
        assert.equal((await api.call('PATCH', '/projects/alpha/permission-groups/X!', body)).status, 404);
        const invalid = await api.call('PATCH', '/projects/alpha/permission-groups/x-checks', {
          label: 'Checks',
          rules: [],
        });
        assert.equal(invalid.status, 400);
      });

      await t.test('Agent-Rechte: nur Befehle, die im Projekt freigegeben sind', async () => {
        assert.equal(await validAgentCommands(pool, 'alpha', null), null);
        assert.deepEqual(await validAgentCommands(pool, 'alpha', ['Bash(make check)']), ['Bash(make check)']);
        assert.match(String(await validAgentCommands(pool, 'beta', ['Bash(make check)'])), /nicht freigegeben/);
        assert.match(String(await validAgentCommands(pool, 'alpha', 'Bash(make check)')), /Liste von Befehlen/);
      });

      await t.test(
        'löschen: Befehle verschwinden aus den Agents, sofern keine andere Kategorie sie enthält',
        async () => {
          const agent = async (slug: string, name: string, commands: string[] | null) =>
            (
              await pool.query<{ id: string }>(
                `INSERT INTO agents (project_slug, name, phase, allowed_commands) VALUES ($1, $2, 'while_task', $3) RETURNING id`,
                [slug, name, commands],
              )
            ).rows[0]!.id;
          const restricted = await agent('alpha', 'Tester', [
            'Bash(make test)',
            'Bash(make check)',
            'Bash(npm run lint:*)',
          ]);
          const standard = await agent('alpha', 'Standard', null);
          const foreign = await agent('beta', 'Fremd', ['Bash(make check)']);
          await pool.query(`UPDATE projects SET agent_permissions = '{files,x-checks}' WHERE slug = 'alpha'`);

          assert.equal((await api.call('DELETE', '/projects/beta/permission-groups/x-checks')).status, 404);
          assert.equal((await api.call('DELETE', '/projects/alpha/permission-groups/x-checks')).status, 204);
          assert.equal((await api.call('DELETE', '/projects/alpha/permission-groups/x-checks')).status, 404);

          const commands = async (id: string) =>
            (await pool.query('SELECT allowed_commands FROM agents WHERE id = $1', [id])).rows[0].allowed_commands;
          assert.deepEqual(
            await commands(restricted),
            ['Bash(make test)', 'Bash(npm run lint:*)'],
            'make test steckt auch in x-build-tools und bleibt',
          );
          assert.equal(await commands(standard), null, 'Projektstandard bleibt Projektstandard');
          assert.deepEqual(await commands(foreign), ['Bash(make check)'], 'anderes Projekt unberührt');
          const enabled = (await pool.query(`SELECT agent_permissions FROM projects WHERE slug = 'alpha'`)).rows[0];
          assert.deepEqual(enabled.agent_permissions, ['files']);
        },
      );
    } finally {
      await api.close();
    }
  });
});
