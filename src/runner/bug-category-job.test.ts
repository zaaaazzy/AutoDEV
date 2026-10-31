import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';
import { categoryFromBug } from '../core/bug-category.js';
import { BUG_CATEGORY_BATCH, backfillBugCategories, type BugClassifier } from './bug-category-job.js';
import type { ScheduledJob } from './scheduler.js';

interface FakeBug {
  id: string;
  title: string;
  description: string;
  category: string | null;
  severity: string;
  status: string;
}

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function bugRow(n: number, description: string, category: string | null = null): FakeBug {
  return { id: id(n), title: `Bug ${n}`, description, category, severity: 'medium', status: 'open' };
}

/** Speicher für bugs und scheduled_jobs, der genau die Anweisungen des Jobs beantwortet. */
function fakePool(bugs: FakeBug[], job: ScheduledJob) {
  const statements: string[] = [];
  const pool = {
    query: async (sql: string, values: unknown[] = []) => {
      statements.push(sql);
      if (sql.includes('FROM bugs') && sql.includes('category IS NULL')) {
        const [cursor, limit] = values as [string | null, number];
        return {
          rows: bugs
            .filter((bug) => bug.category === null && (!cursor || bug.id > cursor))
            .sort((a, b) => a.id.localeCompare(b.id))
            .slice(0, limit)
            .map(({ id: bugId, title, description }) => ({ id: bugId, title, description })),
        };
      }
      if (sql.startsWith('UPDATE bugs SET category = $2 WHERE id = $1 AND category IS NULL')) {
        const [bugId, category] = values as [string, string];
        const bug = bugs.find((entry) => entry.id === bugId && entry.category === null);
        if (bug) bug.category = category;
        return { rowCount: bug ? 1 : 0, rows: [] };
      }
      if (sql.startsWith('UPDATE scheduled_jobs SET state')) {
        job.state = JSON.parse(values[1] as string) as Record<string, unknown>;
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`Unerwartete Anweisung: ${sql.slice(0, 80)}`);
    },
  } as unknown as Pool;
  return { pool, statements };
}

const newJob = (): ScheduledJob => ({
  key: 'bug_categories',
  kind: 'bug_categories',
  config: {},
  intervalSeconds: 86400,
  state: {},
  previousStatus: null,
});

/** Pfade, sonst „Modell“: Titel mit „Doku“ → docs, sonst keine Antwort. */
const classify: BugClassifier = async (bug) => categoryFromBug(bug) ?? (/Doku/.test(bug.description) ? 'docs' : null);

test('Wartungsjob: füllt nur category IS NULL, lässt gesetzte Kategorien (auch abweichende) unverändert', async () => {
  const bugs = [
    bugRow(1, 'Testdatei: `src/core/a.test.ts`'),
    bugRow(2, 'Testdatei: `frontend/src/app/x.spec.ts`'),
    bugRow(3, 'Fehler in deploy/backup.sh'),
    bugRow(4, 'Fehler in src/api/bugs.ts', 'docs'),
    bugRow(5, 'Die Doku stimmt nicht'),
    bugRow(6, 'Nichts Genaues'),
  ];
  const before = structuredClone(bugs);
  const job = newJob();
  const { pool } = fakePool(bugs, job);
  const result = await backfillBugCategories({ pool, job, signal: new AbortController().signal }, classify);
  assert.equal(result.status, 'ok');
  assert.equal(result.state?.done, true);
  assert.deepEqual(
    bugs.map((bug) => bug.category),
    ['backend', 'frontend', 'infrastructure', 'docs', 'docs', null],
  );
  // Nur die Kategorie ändert sich; Bug 4 (von Hand gesetzt, Pfad sagt backend) bleibt genau wie vorher.
  assert.deepEqual(bugs[3], before[3]);
  for (const [index, bug] of bugs.entries())
    assert.deepEqual({ ...bug, category: null }, { ...before[index]!, category: null });
  assert.match(result.message, /4 gesetzt, 1 ohne eindeutige Zuordnung/);
});

test('Wartungsjob: ein zweiter Lauf ändert keinen Bug mehr', async () => {
  const bugs = [bugRow(1, 'in src/api/bugs.ts'), bugRow(2, 'Nichts Genaues')];
  const job = newJob();
  const first = fakePool(bugs, job);
  const result = await backfillBugCategories({ pool: first.pool, job, signal: new AbortController().signal }, classify);
  job.state = result.state ?? job.state;
  // Neuer Bug ohne Kategorie nach dem ersten Lauf: Der einmalige Job fasst ihn nicht mehr an.
  bugs.push(bugRow(3, 'in src/core/x.ts'));
  const snapshot = structuredClone(bugs);
  const second = fakePool(bugs, job);
  const again = await backfillBugCategories({ pool: second.pool, job, signal: new AbortController().signal }, classify);
  assert.equal(again.status, 'ok');
  assert.match(again.message, /Bereits erledigt/);
  assert.deepEqual(bugs, snapshot);
  assert.equal(second.statements.length, 0);
});

test('Wartungsjob: arbeitet in Stapeln und setzt nach einem Abbruch am gemerkten Stand fort', async () => {
  const bugs = Array.from({ length: BUG_CATEGORY_BATCH + 10 }, (_, index) => bugRow(index + 1, 'in src/api/x.ts'));
  const job = newJob();
  const { pool } = fakePool(bugs, job);
  const controller = new AbortController();
  let calls = 0;
  const aborting: BugClassifier = async (bug, options) => {
    calls += 1;
    if (calls === BUG_CATEGORY_BATCH + 3) controller.abort();
    return classify(bug, options);
  };
  const partial = await backfillBugCategories({ pool, job, signal: controller.signal }, aborting);
  assert.equal(partial.status, 'warning');
  assert.notEqual(partial.state?.done, true);
  // Der beim Abbruch angefragte Bug zählt nicht als erledigt; der Stand liegt schon in scheduled_jobs.state.
  assert.equal(bugs.filter((bug) => bug.category).length, BUG_CATEGORY_BATCH + 2);
  assert.equal(job.state.cursor, id(BUG_CATEGORY_BATCH + 2));
  const rest = await backfillBugCategories({ pool, job, signal: new AbortController().signal }, classify);
  assert.equal(rest.status, 'ok');
  assert.equal(rest.state?.done, true);
  assert.ok(bugs.every((bug) => bug.category === 'backend'));
});

test('Wartungsjob: ein Fehler der Einstufung lässt den Bug leer und bricht den Job nicht ab', async () => {
  const bugs = [bugRow(1, 'Nichts Genaues'), bugRow(2, 'in src/api/x.ts')];
  const job = newJob();
  const { pool } = fakePool(bugs, job);
  const failing: BugClassifier = async (bug, options) => {
    if (bug.id === id(1)) throw new Error('Ollama weg');
    return classify(bug, options);
  };
  const result = await backfillBugCategories({ pool, job, signal: new AbortController().signal }, failing);
  assert.equal(result.status, 'ok');
  assert.deepEqual(
    bugs.map((bug) => bug.category),
    [null, 'backend'],
  );
});
