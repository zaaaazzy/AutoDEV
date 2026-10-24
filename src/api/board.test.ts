import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import express from 'express';
import type { Pool } from 'pg';
import { registerBoardRoutes } from './board.js';

interface Row {
  id: string;
  status: string | null;
  source?: string;
  createdAt: Date;
}

const newestFirst = (a: Row, b: Row): number => b.createdAt.getTime() - a.createdAt.getTime();

/**
 * Wertet einen Teil einer Board-Abfrage wie Postgres aus: Herkunft ($2 bei Ideen), Statusfilter
 * `status = ANY($n)` bzw. `(status = ANY($n)) IS NOT TRUE` (NULL zählt als offen), `created_at DESC` und `LIMIT`.
 */
function select(table: 'ideation_items' | 'development_items', all: Row[], sql: string, values: unknown[]): Row[] {
  let rows = [...all];
  if (table === 'ideation_items' && values[1]) rows = rows.filter((row) => row.source === values[1]);
  const open = /\(status = ANY\(\$(\d+)::text\[\]\)\) IS NOT TRUE/.exec(sql);
  const closed = /(?<!\()status = ANY\(\$(\d+)::text\[\]\)/.exec(sql);
  if (open) {
    const statuses = values[Number(open[1]) - 1] as string[];
    rows = rows.filter((row) => row.status === null || !statuses.includes(row.status));
  } else if (closed) {
    const statuses = values[Number(closed[1]) - 1] as string[];
    rows = rows.filter((row) => row.status !== null && statuses.includes(row.status));
  }
  const limit = /LIMIT (\d+)/.exec(sql);
  if (!limit) return rows;
  assert.match(sql, /ORDER BY created_at DESC/, 'LIMIT ohne Sortierung trifft beliebige Zeilen');
  return rows.sort(newestFirst).slice(0, Number(limit[1]));
}

/** Pool-Attrappe für die Board-Route; `UNION ALL` wird teilweise ausgewertet und am Ende neueste zuerst sortiert. */
function boardPool(tables: { ideation_items: Row[]; development_items: Row[] }): Pool {
  return {
    query: async (sql: string, values: unknown[] = []) => {
      const table = /FROM (ideation_items|development_items)\b/.exec(sql)?.[1] as keyof typeof tables | undefined;
      if (!table || sql.includes('ideation_comments')) return { rows: [] };
      // DEV_COLUMNS enthält ein Unter-Select mit eigenem „LIMIT 1“; es betrifft nicht die Zeilenauswahl.
      const parts = sql.replace(/\(SELECT f\.status[\s\S]*?\) AS "fixStatus"/g, '').split('UNION ALL');
      const rows = parts.flatMap((part) => select(table, tables[table], part, values));
      if (parts.length > 1) assert.match(parts.at(-1) ?? '', /\)\s*ORDER BY "createdAt" DESC\s*$/);
      return { rows: parts.length > 1 ? rows.sort(newestFirst) : rows };
    },
  } as unknown as Pool;
}

const start = Date.UTC(2026, 0, 1);
function rows(prefix: string, count: number, status: string | null, offsetMinutes: number, source?: string): Row[] {
  return Array.from({ length: count }, (_value, index) => ({
    id: `${prefix}-${index}`,
    status,
    source,
    createdAt: new Date(start + (offsetMinutes + index) * 60_000),
  }));
}

async function fetchBoard(pool: Pool, query = ''): Promise<{ ideas: Row[]; development: Row[] }> {
  const app = express();
  registerBoardRoutes(app, pool);
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/projects/dev-log/board${query}`);
    assert.equal(response.status, 200);
    return (await response.json()) as { ideas: Row[]; development: Row[] };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function sortedDesc(list: Row[]): boolean {
  return list.every((row, index) => index === 0 || (list[index - 1]?.createdAt ?? row.createdAt) >= row.createdAt);
}

test('Board: älterer blockierter Auftrag erscheint trotz 229 neuerer Aufträge (200 geplant, 29 erledigt)', async () => {
  const development = [
    ...rows('blocked', 1, 'blocked', 0),
    ...rows('planned', 200, 'planned', 10),
    ...rows('done', 29, 'done', 500),
  ];
  const board = await fetchBoard(boardPool({ ideation_items: [], development_items: development }));
  const ids = board.development.map((row) => row.id);
  assert.ok(ids.includes('blocked-0'), 'der ältere blockierte Auftrag fehlt im Board');
  assert.equal(board.development.length, 230);
  assert.equal(new Set(ids).size, ids.length, 'keine doppelten Einträge');
  assert.ok(sortedDesc(board.development.map((row) => ({ ...row, createdAt: new Date(row.createdAt) }))));
  assert.equal(ids[0], 'done-28');
  assert.equal(ids.at(-1), 'blocked-0');
});

test('Board: erledigte und abgelehnte Aufträge bleiben auf die 200 neuesten begrenzt, offene nicht', async () => {
  const development = [
    ...rows('old-progress', 1, 'in_progress', 0),
    ...rows('done', 180, 'done', 10),
    ...rows('rejected', 50, 'rejected', 300),
    ...rows('backlog', 250, 'backlog', 400),
  ];
  const board = await fetchBoard(boardPool({ ideation_items: [], development_items: development }));
  const closed = board.development.filter((row) => row.status === 'done' || row.status === 'rejected');
  assert.equal(closed.length, 200);
  // Die ältesten 30 erledigten fallen weg.
  assert.ok(!closed.some((row) => row.id === 'done-29'));
  assert.ok(closed.some((row) => row.id === 'done-30'));
  assert.equal(board.development.filter((row) => row.status === 'backlog').length, 250);
  assert.ok(board.development.some((row) => row.id === 'old-progress-0'));
});

test('Board: Aufträge ohne Status gelten als offen und gehen nicht verloren', async () => {
  const development = [...rows('nostatus', 1, null, 0), ...rows('done', 210, 'done', 10)];
  const board = await fetchBoard(boardPool({ ideation_items: [], development_items: development }));
  assert.ok(board.development.some((row) => row.id === 'nostatus-0'));
  assert.equal(board.development.length, 201);
});

test('Board: ältere offene Ideen erscheinen trotz 200 neuerer Ideen, Herkunftsfilter gilt weiter', async () => {
  const ideas = [
    ...rows('old-idea', 1, 'considering', 0, 'visionary'),
    ...rows('accepted', 150, 'accepted', 10, 'visionary'),
    ...rows('rejected', 100, 'rejected', 200, 'visionary'),
    ...rows('manual', 5, 'idea', 400, 'manual'),
  ];
  const all = await fetchBoard(boardPool({ ideation_items: ideas, development_items: [] }));
  assert.ok(all.ideas.some((row) => row.id === 'old-idea-0'));
  assert.equal(all.ideas.filter((row) => row.status === 'accepted' || row.status === 'rejected').length, 200);

  const visionary = await fetchBoard(boardPool({ ideation_items: ideas, development_items: [] }), '?source=visionary');
  assert.ok(visionary.ideas.some((row) => row.id === 'old-idea-0'));
  assert.ok(visionary.ideas.every((row) => row.source === 'visionary'));
});
