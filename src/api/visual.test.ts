import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import type { Pool } from 'pg';
import { createDevLogApp } from './app.js';
import type { Principal } from './roles.js';
import { guardStatus, requiredRole } from './route-table.test.js';
import { projectOfTenant } from './tenancy.js';
import { parsePreviewSettings } from './visual.js';

const ORDER = '0b6f1c7e-1d2a-4c3b-9e8f-112233445566';
const OWN_SHOT = '3a6f1c7e-1d2a-4c3b-9e8f-112233445566';
const FOREIGN_SHOT = '4b6f1c7e-1d2a-4c3b-9e8f-112233445566';
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

function placeholders(sql: string): number[] {
  return [...new Set([...sql.matchAll(/\$(\d+)/g)].map((match) => Number(match[1])))].sort((a, b) => a - b);
}

async function withServer(pool: Pool, run: (base: string) => Promise<void>): Promise<void> {
  const server = createDevLogApp(pool, null).listen(0, '127.0.0.1');
  try {
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const { port } = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('Projekt-Einstellungen: Vorschau-Adresse, Seiten und Einstellungen', () => {
  const sets = parsePreviewSettings({
    previewUrl: ' http://localhost:4200 ',
    previewPages: '/\n/#dashboard',
    visualSettings: { tolerance: 1, masks: ['.time'] },
  });
  assert.ok(Array.isArray(sets));
  assert.deepEqual(sets[0], ['preview_url', 'http://localhost:4200']);
  assert.deepEqual(JSON.parse(String(sets[1]?.[1])), ['/', '/#dashboard']);
  assert.equal(JSON.parse(String(sets[2]?.[1])).tolerance, 1);
  assert.deepEqual(parsePreviewSettings({ previewUrl: '' }), [['preview_url', null]]);
  assert.match(String(parsePreviewSettings({ previewUrl: 'javascript:alert(1)' })), /Vorschau-Adresse/);
  assert.match(String(parsePreviewSettings({ previewPages: ['ohne-slash'] })), /Seiten/);
  assert.deepEqual(parsePreviewSettings({}), []);
});

test('Snapshots eines Auftrags, Bildauslieferung und optische Freigabe', async () => {
  const queries: { sql: string; values: unknown[] }[] = [];
  const pool = {
    query: async (sql: string, values: unknown[] = []) => {
      queries.push({ sql, values });
      if (sql.includes('FROM development_items WHERE id')) return { rows: [{ approvedAt: null, approvedBy: null }] };
      if (sql.includes('WITH own AS')) {
        return { rows: [{ id: OWN_SHOT, page: '/', device: 'mobile', kind: 'shot', diffPercent: 1.5, baseId: null }] };
      }
      if (sql.includes('SELECT data FROM visual_snapshots')) {
        return { rows: values[0] === OWN_SHOT ? [{ data: PNG_BYTES }] : [] };
      }
      if (sql.includes('UPDATE development_items')) {
        return {
          rows: [{ approvedAt: values[1] ? '2026-10-20T10:00:00Z' : null, approvedBy: values[1] ? values[2] : null }],
        };
      }
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Pool;
  await withServer(pool, async (base) => {
    const list = await fetch(`${base}/api/development/${ORDER}/visual`);
    assert.equal(list.status, 200);
    const body = (await list.json()) as { snapshots: { id: string }[]; approval: unknown };
    assert.equal(body.snapshots[0]?.id, OWN_SHOT);

    const image = await fetch(`${base}/api/visual-snapshots/${OWN_SHOT}`);
    assert.equal(image.status, 200);
    assert.equal(image.headers.get('content-type'), 'image/png');
    assert.equal(image.headers.get('content-security-policy'), "default-src 'none'");
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), PNG_BYTES);
    assert.equal((await fetch(`${base}/api/visual-snapshots/${FOREIGN_SHOT}`)).status, 404);
    assert.equal((await fetch(`${base}/api/visual-snapshots/kein-uuid`)).status, 404);

    const approve = await fetch(`${base}/api/development/${ORDER}/visual/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(approve.status, 200);
    assert.deepEqual(await approve.json(), { approval: { approvedAt: '2026-10-20T10:00:00Z', approvedBy: 'Lokal' } });
    const revoke = await fetch(`${base}/api/development/${ORDER}/visual/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approved: false }),
    });
    assert.deepEqual(await revoke.json(), { approval: { approvedAt: null, approvedBy: null } });
  });
  const update = queries.find((query) => query.sql.includes('UPDATE development_items'));
  assert.ok(update);
  assert.deepEqual(placeholders(update.sql), [1, 2, 3]);
  assert.deepEqual(update.values, [ORDER, true, 'Lokal']);
});

test('Snapshots nur für Nutzer des zugehörigen Projekts (fremde Mandanten: 404)', async () => {
  const owner: Record<string, string> = { [OWN_SHOT]: 'alpha', [FOREIGN_SHOT]: 'beta' };
  const pool = {
    query: async (sql: string, values: unknown[]) => {
      if (sql.includes('project_members')) return { rows: [{ slug: 'alpha' }] };
      assert.match(sql, /FROM visual_snapshots WHERE id = \$1/);
      const slug = owner[values[0] as string];
      return { rows: slug ? [{ slug }] : [] };
    },
  } as unknown as Pool;
  assert.equal(await projectOfTenant(pool, 'visual-snapshots', { id: OWN_SHOT }), 'alpha');
  const member: Principal = {
    id: '2d6f1c7e-1d2a-4c3b-9e8f-112233445566',
    username: 'ana',
    displayName: 'Ana',
    roles: ['plan'],
  };
  const status = (path: string): Promise<number> => guardStatus(pool, member, 'GET', path);
  assert.equal(await status(`/api/visual-snapshots/${OWN_SHOT}`), 200);
  assert.equal(await status(`/api/visual-snapshots/${FOREIGN_SHOT}`), 404);
  assert.equal(requiredRole('POST', `/api/development/${ORDER}/visual/approve`, {}), 'run');
});
