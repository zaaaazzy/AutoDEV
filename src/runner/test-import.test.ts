import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Pool } from 'pg';
import type { CommandExecutor } from '../core/command.js';
import type { FullTestResult } from '../core/full-test-result.js';
import { importFullTestResult } from './test-import.js';
import { processTestRequest } from './test-request.js';

function fakePool(claim?: { id: string; scope: 'full' | 'ui' }) {
  const queries: { sql: string; params: unknown[] }[] = [];
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      if (claim && sql.includes("SET status = 'running'")) return { rows: [claim] };
      if (sql.includes('max(position)')) return { rows: [{ position: 0 }] };
      if (sql.includes('INSERT INTO test_cases')) return { rows: [{ id: `case-${queries.length}` }] };
      if (sql.includes('INSERT INTO bugs')) return { rows: [], rowCount: 1 };
      return { rows: [] };
    },
  } as unknown as Pool;
  return { pool, queries };
}

const result = (media: { name: string; mime: 'image/png'; path: string }[]): FullTestResult => ({
  version: 1,
  startedAt: '2026-10-29T09:00:00.000Z',
  platform: 'linux',
  passed: false,
  steps: [
    {
      name: 'Lint',
      command: 'npm run lint',
      category: 'quality',
      ok: true,
      seconds: 3,
      summary: 'ok',
      tail: '',
      cases: [],
    },
    {
      name: 'Oberflächentest',
      command: 'npx playwright test -c e2e/full.config.ts',
      category: 'user',
      ok: false,
      seconds: 40,
      summary: '1 failed',
      tail: 'Fehler',
      cases: [
        {
          category: 'user',
          title: 'Dashboard',
          file: 'e2e/full-ui.check.ts',
          device: 'desktop',
          status: 'failed',
          durationMs: 1200,
          errors: ['Knopf fehlt'],
          media,
        },
      ],
    },
  ],
});

test('Ergebnisdatei aus der Sandbox: Testlauf mit Schritten, Screenshot, Bericht und Bug, Pfade nur im Projekt', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'test-import-'));
  const outside = await mkdtemp(join(tmpdir(), 'test-import-host-'));
  try {
    await mkdir(join(cwd, 'docs/tests/2026-10-29_09-00/media'), { recursive: true });
    await writeFile(join(cwd, 'docs/tests/2026-10-29_09-00/media/001-dashboard.png'), 'png-daten');
    await writeFile(join(outside, 'geheim.png'), 'host-datei');
    await symlink(join(outside, 'geheim.png'), join(cwd, 'docs/tests/2026-10-29_09-00/media/002-link.png'));
    await mkdir(join(cwd, 'test-results'));
    await writeFile(
      join(cwd, 'test-results/ergebnis.json'),
      JSON.stringify(
        result([
          { name: 'dashboard', mime: 'image/png', path: 'docs/tests/2026-10-29_09-00/media/001-dashboard.png' },
          { name: 'link', mime: 'image/png', path: 'docs/tests/2026-10-29_09-00/media/002-link.png' },
          { name: 'ausbruch', mime: 'image/png', path: join('..', outside.split('/').at(-1)!, 'geheim.png') },
          { name: 'absolut', mime: 'image/png', path: join(outside, 'geheim.png') },
        ]),
      ),
    );
    const { pool, queries } = fakePool();
    const runId = await importFullTestResult(pool, {
      project: 'demo',
      cwd,
      file: join(cwd, 'test-results/ergebnis.json'),
      requestId: 'req-5',
      branch: 'HEAD',
      commitSha: 'abc',
      bugs: true,
    });
    assert.ok(runId);
    const run = queries.find((q) => q.sql.includes('INSERT INTO test_runs'));
    assert.deepEqual(run?.params.slice(1), ['demo', 'full', 'HEAD', 'abc', 'linux']);
    assert.ok(queries.some((q) => q.sql.includes('SET run_id') && q.params[1] === runId));
    assert.equal(queries.filter((q) => q.sql.includes('INSERT INTO test_run_steps')).length, 2);
    const media = queries.filter((q) => q.sql.includes('INSERT INTO test_media'));
    assert.equal(media.length, 1, 'nur der Screenshot im Projektordner, kein Symlink und kein Pfad nach draussen');
    assert.equal(String(media[0]!.params[5]), 'png-daten');
    assert.ok(queries.some((q) => q.sql.includes('INSERT INTO bugs') && /Dashboard/.test(String(q.params[1]))));
    assert.ok(queries.some((q) => q.sql.includes('bug_count') && q.params[1] === 1));
    const report = queries.find((q) => q.sql.includes('SET report'));
    assert.match(String(report?.params[1]), new RegExp(`#runs/${runId}`));
    assert.ok(queries.some((q) => q.sql.includes('UPDATE test_runs') && q.params[1] === 'failed'));

    // Ergebnisdatei ausserhalb des Projekts oder kaputt: kein Testlauf.
    await writeFile(join(outside, 'ergebnis.json'), JSON.stringify(result([])));
    const other = fakePool();
    const options = { project: 'demo', cwd, requestId: 'r', branch: null, commitSha: null, bugs: false };
    assert.equal(await importFullTestResult(other.pool, { ...options, file: join(outside, 'ergebnis.json') }), null);
    await writeFile(join(cwd, 'test-results/kaputt.json'), '{');
    assert.equal(
      await importFullTestResult(other.pool, { ...options, file: join(cwd, 'test-results/kaputt.json') }),
      null,
    );
    assert.equal(other.queries.length, 0);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('Komplettlauf in der Sandbox: rot ohne eigenen Testlauf, aber mit Ergebnisdatei → Lauf importiert, Datei entfernt', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'test-request-import-'));
  try {
    await writeFile(
      join(cwd, 'package.json'),
      JSON.stringify({ scripts: { 'test:full': 'tsx scripts/test-full.ts' } }),
    );
    await mkdir(join(cwd, 'shots'));
    await writeFile(join(cwd, 'shots/a.png'), 'png');
    const { pool, queries } = fakePool({ id: 'req-8', scope: 'full' });
    let file = '';
    const execute: CommandExecutor = async (command) => {
      if (command.includes('test:full')) {
        file = command[command.indexOf('--ergebnis') + 1]!;
        await mkdir(join(cwd, 'test-results'), { recursive: true });
        await writeFile(
          join(cwd, file),
          JSON.stringify(result([{ name: 'a', mime: 'image/png', path: 'shots/a.png' }])),
        );
        return { exitCode: 1, durationMs: 0, output: '1 failed' };
      }
      return { exitCode: command[0] === 'git' ? 1 : 0, durationMs: 0, output: '' };
    };
    assert.equal(await processTestRequest(pool, { project: 'demo', cwd }, execute), true);
    assert.equal(file, 'test-results/aideation-anfrage-req-8.json');
    assert.ok(queries.some((q) => q.sql.includes('INSERT INTO test_media')));
    assert.ok(
      queries.some((q) => q.sql.includes("SET status = 'done'")),
      'Anforderung erledigt, nicht gescheitert',
    );
    assert.ok(!queries.some((q) => q.sql.includes("test_requests SET status = 'failed'")));
    assert.equal(existsSync(join(cwd, file)), false, 'Ergebnisdatei nach dem Import entfernt');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
