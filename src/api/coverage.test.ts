import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import type { Pool } from 'pg';
import { COVERAGE_AREA_KEYS } from '../core/coverage-areas.js';
import { createDevLogApp } from './app.js';
import { coverageTrend } from './coverage.js';

test('coverageTrend: je fester Bereich eine Zeitreihe nach Datum, Lücken bleiben null, Altbestand ausgeblendet', () => {
  const trend = coverageTrend([
    { reportId: 'b', createdAt: '2026-10-29T10:00:00Z', area: 'backend', lines: 82, branches: 70, tests: '12' },
    {
      reportId: 'a',
      createdAt: new Date('2026-10-28T10:00:00Z'),
      area: 'backend',
      lines: null,
      branches: 60,
      tests: 9,
    },
    { reportId: 'a', createdAt: '2026-10-28T10:00:00Z', area: 'Sonstiges', lines: 90, branches: 90, tests: 2 },
  ]);
  assert.deepEqual(
    trend.map((entry) => entry.area),
    [...COVERAGE_AREA_KEYS],
  );
  assert.deepEqual(trend[0]!.points, [
    { reportId: 'a', date: '2026-10-28T10:00:00.000Z', lines: null, branches: 60, tests: 9 },
    { reportId: 'b', date: '2026-10-29T10:00:00.000Z', lines: 82, branches: 70, tests: 12 },
  ]);
  assert.ok(trend.every((entry) => entry.area === 'backend' || entry.points.length === 0));
});

/** Coverage-Routen gegen eine Pool-Attrappe; writes = geschriebene Abdeckungszeilen. */
async function request(method: 'GET' | 'POST', path: string, body?: unknown) {
  const queries: { sql: string; values: unknown[] }[] = [];
  const query = async (sql: string, values: unknown[] = []) => {
    queries.push({ sql, values });
    if (sql.includes('RETURNING id')) return { rows: [{ id: 'r-1' }], rowCount: 1 };
    if (sql.includes('AS tests')) {
      return {
        rows: [
          { reportId: 'r-1', createdAt: '2026-10-30T08:00:00Z', area: 'gesamt', lines: 80, branches: 70, tests: 5 },
        ],
      };
    }
    return { rows: [], rowCount: 0 };
  };
  const pool = { query, connect: async () => ({ query, release: () => undefined }) } as unknown as Pool;
  const server = createDevLogApp(pool, null).listen(0, '127.0.0.1');
  try {
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/api${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return {
      status: response.status,
      body: (await response.json()) as { message?: string; areas?: { area: string; points: unknown[] }[] },
      writes: queries.filter((entry) => /INSERT INTO test_coverage/.test(entry.sql)),
      queries,
    };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const valid = { area: 'backend', unit: 3, lines: 80, branches: 60 };

for (const [label, area] of [
  ['unbekannter Bereich', { ...valid, area: 'Sonstiges' }],
  ['fehlender Zeilenwert', { ...valid, lines: null }],
  ['fehlender Zweigwert', { area: 'backend', unit: 3, lines: 80 }],
  ['0 Testfälle', { ...valid, unit: 0 }],
] as const) {
  test(`POST /projects/:slug/coverage: ${label} → 400 mit Meldung, nichts gespeichert`, async () => {
    const result = await request('POST', '/projects/dev-log/coverage', { summary: 'x', areas: [area] });
    assert.equal(result.status, 400);
    assert.match(result.body.message ?? '', /^Testabdeckung abgelehnt: Bereich/);
    assert.deepEqual(result.writes, []);
  });
}

test('POST /projects/:slug/coverage: gültige Meldung wird gespeichert', async () => {
  const result = await request('POST', '/projects/dev-log/coverage', { summary: 'CI', areas: [valid] });
  assert.equal(result.status, 201);
  assert.equal(result.writes.length, 2);
  assert.equal(result.writes[1]?.values[1], 'backend');
});

test('GET /projects/:slug/coverage/trend: nur feste Bereiche werden abgefragt', async () => {
  const result = await request('GET', '/projects/dev-log/coverage/trend');
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.areas?.find((entry) => entry.area === 'gesamt')?.points.length, 1);
  const sql = result.queries.find((entry) => entry.sql.includes('AS tests'));
  assert.deepEqual(sql?.values[1], [...COVERAGE_AREA_KEYS]);
});
