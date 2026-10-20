import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Pool } from 'pg';
import type { PushAudience, PushMessage } from '../core/push.js';
import {
  claimDueJobs,
  isDue,
  JOB_KINDS,
  type JobKind,
  insideRoot,
  jobKind,
  nextRunAfter,
  runDueJobs,
  runWithTimeout,
  type SchedulerDeps,
} from './scheduler.js';
import { REMIND_MS } from './watchdog.js';

interface FakeJob {
  key: string;
  enabled: boolean;
  kind: string;
  config: Record<string, unknown>;
  intervalSeconds: number;
  nextRunAt: Date;
  lockedUntil: Date | null;
  lastRunAt: Date | null;
  lastStatus: string | null;
  lastMessage: string | null;
  state: Record<string, unknown>;
}

const HOUR = 3600_000;

function job(key: string, overrides: Partial<FakeJob> = {}): FakeJob {
  return {
    key,
    enabled: true,
    kind: key,
    config: {},
    intervalSeconds: 3600,
    nextRunAt: new Date(Date.now() - 1000),
    lockedUntil: null,
    lastRunAt: null,
    lastStatus: null,
    lastMessage: null,
    state: {},
    ...overrides,
  };
}

/**
 * Speicher für scheduled_jobs, der genau die Anweisungen des Schedulers beantwortet. Jede Anweisung läuft ohne
 * await durch – wie eine Zeilensperre in Postgres kann kein zweiter Aufruf dazwischenkommen.
 */
function fakePool(jobs: FakeJob[], extra?: (sql: string, values: unknown[]) => { rows: unknown[] } | null) {
  const statements: string[] = [];
  const pool = {
    query: async (sql: string, values: unknown[] = []) => {
      statements.push(sql);
      const now = new Date();
      if (sql.startsWith('UPDATE scheduled_jobs j')) {
        const [limit, lockSeconds] = values as [number, number];
        const due = jobs
          .filter((row) => isDue(row, now))
          .sort((a, b) => a.nextRunAt.getTime() - b.nextRunAt.getTime())
          .slice(0, limit);
        return {
          rows: due.map((row) => {
            const previousStatus = row.lastStatus;
            row.nextRunAt = nextRunAfter(row.nextRunAt, row.intervalSeconds, now);
            row.lockedUntil = new Date(now.getTime() + lockSeconds * 1000);
            row.lastRunAt = now;
            row.lastStatus = 'running';
            return {
              key: row.key,
              kind: row.kind,
              config: row.config,
              intervalSeconds: row.intervalSeconds,
              state: row.state,
              previousStatus,
            };
          }),
        };
      }
      if (sql.startsWith('UPDATE scheduled_jobs SET last_status')) {
        const [key, status, message, state] = values as [string, string, string, string | null];
        const row = jobs.find((entry) => entry.key === key)!;
        row.lastStatus = status;
        row.lastMessage = message;
        if (state) row.state = JSON.parse(state) as Record<string, unknown>;
        row.lockedUntil = null;
        return { rows: [] };
      }
      if (sql.startsWith('UPDATE scheduled_jobs SET next_run_at = LEAST')) {
        const keys = values[0] as string[];
        const woken = jobs.filter((row) => {
          const watched = Array.isArray(row.config.jobs) ? (row.config.jobs as string[]) : null;
          return (
            row.enabled &&
            row.kind === 'push_alert' &&
            !keys.includes(row.key) &&
            (!watched || watched.some((key) => keys.includes(key)))
          );
        });
        for (const row of woken) if (row.nextRunAt > now) row.nextRunAt = now;
        return {
          rows: woken.map((row) => ({
            key: row.key,
            jobs: Array.isArray(row.config.jobs) ? row.config.jobs : null,
          })),
        };
      }
      if (sql.includes('FROM scheduled_jobs')) {
        const [self, watched] = values as [string, string[] | null];
        return {
          rows: jobs
            .filter(
              (row) =>
                row.key !== self && row.enabled && row.kind !== 'push_alert' && (!watched || watched.includes(row.key)),
            )
            .sort((a, b) => a.key.localeCompare(b.key))
            .map((row) => ({ key: row.key, status: row.lastStatus, message: row.lastMessage })),
        };
      }
      const answer = extra?.(sql, values);
      if (answer) return answer;
      throw new Error(`Unerwartete Anweisung: ${sql.slice(0, 80)}`);
    },
  } as unknown as Pool;
  return { pool, statements };
}

/** Zählende Test-Registry. */
function countingKind(run?: JobKind['run']): JobKind & { calls: number } {
  const kind = {
    calls: 0,
    defaultTimeoutSeconds: 5,
    run: async (context: Parameters<JobKind['run']>[0]) => {
      kind.calls += 1;
      return run ? run(context) : { status: 'ok' as const, message: 'erledigt' };
    },
  };
  return kind;
}

function pushRecorder(): {
  sent: { message: PushMessage; audience: PushAudience | undefined }[];
  push: NonNullable<SchedulerDeps['push']>;
} {
  const sent: { message: PushMessage; audience: PushAudience | undefined }[] = [];
  return {
    sent,
    push: async (_pool, message, audience) => {
      sent.push({ message, audience });
      return 1;
    },
  };
}

const deps = (extra: Partial<SchedulerDeps> = {}): SchedulerDeps => ({
  installRoot: tmpdir(),
  push: async () => 0,
  ...extra,
});

test('Fälligkeit: nächster Termin liegt im Raster immer in der Zukunft; inaktiv oder gesperrt ist nie fällig', () => {
  const start = new Date('2026-10-20T08:00:00Z');
  assert.equal(nextRunAfter(start, 3600, new Date('2026-10-20T08:00:00Z')).toISOString(), '2026-10-20T09:00:00.000Z');
  // Worker stand drei Stunden: kein Nachholen, nächster Termin im ursprünglichen Raster.
  assert.equal(nextRunAfter(start, 3600, new Date('2026-10-20T11:30:00Z')).toISOString(), '2026-10-20T12:00:00.000Z');
  const now = new Date('2026-10-20T08:00:01Z');
  assert.ok(isDue({ enabled: true, nextRunAt: start, lockedUntil: null }, now));
  assert.ok(!isDue({ enabled: false, nextRunAt: start, lockedUntil: null }, now), 'inaktiv');
  assert.ok(!isDue({ enabled: true, nextRunAt: new Date('2026-10-20T09:00:00Z'), lockedUntil: null }, now));
  assert.ok(!isDue({ enabled: true, nextRunAt: start, lockedUntil: new Date('2026-10-20T08:05:00Z') }, now));
  assert.ok(isDue({ enabled: true, nextRunAt: start, lockedUntil: new Date('2026-10-20T07:59:00Z') }, now));
});

test('Beanspruchung in einer Anweisung mit SKIP LOCKED, Sperre und neuem Termin', async () => {
  const { pool, statements } = fakePool([job('a')]);
  const claimed = await claimDueJobs(pool);
  assert.equal(claimed.length, 1);
  const sql = statements[0]!;
  assert.match(sql, /FOR UPDATE SKIP LOCKED/);
  assert.match(sql, /WHERE enabled AND next_run_at <= NOW\(\)/);
  assert.match(sql, /SET next_run_at = /);
  assert.match(sql, /locked_until = NOW\(\)/);
  assert.match(sql, /RETURNING/);
});

test('ein fälliger aktiver Job läuft genau einmal; next_run_at rückt um das Intervall vor; inaktive laufen nie', async () => {
  const due = job('due', { kind: 'count', intervalSeconds: 600, nextRunAt: new Date(Date.now() - 1000) });
  const off = job('off', { kind: 'count', enabled: false, nextRunAt: new Date(Date.now() - 10 * HOUR) });
  const before = due.nextRunAt.getTime();
  const { pool } = fakePool([due, off]);
  const kind = countingKind();
  const registry = { count: kind };
  const runs = await runDueJobs(pool, deps(), undefined, registry);
  assert.deepEqual(
    runs.map((run) => [run.key, run.status]),
    [['due', 'ok']],
  );
  assert.equal(kind.calls, 1);
  assert.equal(due.nextRunAt.getTime(), before + 600_000);
  assert.equal(due.lastStatus, 'ok');
  assert.equal(due.lastMessage, 'erledigt');
  assert.ok(due.lastRunAt);
  assert.equal(due.lockedUntil, null, 'Sperre wieder frei');
  assert.equal(off.lastStatus, null, 'inaktiv bleibt unberührt');
  // Nächster Zyklus: noch nicht wieder fällig.
  assert.deepEqual(await runDueJobs(pool, deps(), undefined, registry), []);
  assert.equal(kind.calls, 1);
});

test('zwei gleichzeitig laufende Worker führen einen fälligen Job nur einmal aus', async () => {
  const { pool } = fakePool([job('shared', { kind: 'slow' })]);
  const kind = countingKind(async () => {
    await new Promise((done) => setTimeout(done, 20));
    return { status: 'ok', message: 'fertig' };
  });
  const registry = { slow: kind };
  const [first, second] = await Promise.all([
    runDueJobs(pool, deps(), undefined, registry),
    runDueJobs(pool, deps(), undefined, registry),
  ]);
  assert.equal(kind.calls, 1);
  assert.equal(first.length + second.length, 1);
});

test('ein noch laufender (gesperrter) Job wird auch bei verpasstem Termin nicht doppelt gestartet', async () => {
  const locked = job('locked', { kind: 'count', lockedUntil: new Date(Date.now() + 60_000) });
  const { pool } = fakePool([locked]);
  const kind = countingKind();
  assert.deepEqual(await runDueJobs(pool, deps(), undefined, { count: kind }), []);
  assert.equal(kind.calls, 0);
});

test('ein geändertes Intervall gilt ab dem nächsten Zyklus, ohne Neustart', async () => {
  const row = job('tick', { kind: 'count', intervalSeconds: 3600 });
  const { pool } = fakePool([row]);
  const registry = { count: countingKind() };
  await runDueJobs(pool, deps(), undefined, registry);
  // Administrator setzt 120 s; der Endpunkt taktet next_run_at neu ab dem letzten Lauf.
  row.intervalSeconds = 120;
  row.nextRunAt = new Date(row.lastRunAt!.getTime() + 120_000 - 200_000);
  const before = row.nextRunAt.getTime();
  await runDueJobs(pool, deps(), undefined, registry);
  assert.equal(registry.count.calls, 2);
  assert.equal(row.nextRunAt.getTime(), before + 120_000, 'neues Raster mit 120 s');
});

test('unbekannte Job-Art: übersprungen, Fehlerstatus gespeichert, andere Jobs laufen weiter', async () => {
  const unknown = job('mystery', { kind: '/usr/bin/rm -rf /' });
  const proto = job('proto', { kind: 'constructor' });
  const fine = job('fine', { kind: 'count' });
  const { pool } = fakePool([unknown, proto, fine]);
  const kind = countingKind();
  const runs = await runDueJobs(pool, deps(), undefined, { count: kind });
  assert.equal(unknown.lastStatus, 'failed');
  assert.match(unknown.lastMessage!, /unbekannte Job-Art/);
  assert.equal(proto.lastStatus, 'failed', 'Object-Prototyp gilt nicht als Job-Art');
  assert.equal(fine.lastStatus, 'ok');
  assert.equal(kind.calls, 1);
  assert.equal(runs.length, 3);
  assert.ok(unknown.nextRunAt > new Date(), 'nächster Lauf trotzdem terminiert');
});

test('ein Fehler im Job bricht den Durchgang nicht ab und wird gespeichert', async () => {
  const broken = job('broken', { kind: 'boom' });
  const fine = job('fine', { kind: 'count', nextRunAt: new Date(Date.now() - 500) });
  const { pool } = fakePool([broken, fine]);
  const registry = {
    boom: countingKind(async () => {
      throw new Error('Platte voll');
    }),
    count: countingKind(),
  };
  await runDueJobs(pool, deps(), undefined, registry);
  assert.equal(broken.lastStatus, 'failed');
  assert.match(broken.lastMessage!, /Platte voll/);
  assert.ok(broken.nextRunAt > new Date());
  assert.equal(fine.lastStatus, 'ok');
});

test('Zeitlimit: ein hängender Job endet nach timeoutSeconds als Fehler, der Durchgang geht weiter', async () => {
  const hanging = job('hang', { kind: 'hang', config: { timeoutSeconds: 1 } });
  const fine = job('fine', { kind: 'count', nextRunAt: new Date(Date.now() - 500) });
  const { pool } = fakePool([hanging, fine]);
  let aborted = false;
  const registry = {
    hang: countingKind(
      ({ signal }) =>
        new Promise((_, reject) => {
          signal.addEventListener('abort', () => {
            aborted = true;
            reject(new Error('abgebrochen'));
          });
        }),
    ),
    count: countingKind(),
  };
  const started = Date.now();
  await runDueJobs(pool, deps(), undefined, registry);
  assert.ok(Date.now() - started < 3000, 'nicht länger als das Zeitlimit');
  assert.equal(hanging.lastStatus, 'failed');
  assert.match(hanging.lastMessage!, /Zeitlimit von 1 s/);
  assert.ok(aborted, 'Job bekommt das Abbruchsignal');
  assert.equal(fine.lastStatus, 'ok');
});

test('runWithTimeout liefert das Ergebnis oder bricht nach der Frist ab', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  assert.equal(await runWithTimeout(async () => 'ok', 1000), 'ok');
  const pending = runWithTimeout(() => new Promise(() => undefined), 5000);
  t.mock.timers.tick(5000);
  await assert.rejects(pending, /Zeitlimit von 5 s/);
});

test('beim Herunterfahren werden keine neuen Jobs beansprucht', async () => {
  const row = job('a', { kind: 'count' });
  const { pool, statements } = fakePool([row]);
  assert.deepEqual(await runDueJobs(pool, deps(), () => true, { count: countingKind() }), []);
  assert.equal(statements.length, 0);
  assert.equal(row.lastStatus, null);
});

test('Registry: genau die vier festen Job-Arten, keine Pfade', () => {
  assert.deepEqual(Object.keys(JOB_KINDS).sort(), ['backup_check', 'close_old_sprints', 'push_alert', 'watchdog_logs']);
  assert.ok(Object.isFrozen(JOB_KINDS));
  assert.equal(jobKind('backup_check'), JOB_KINDS.backup_check);
  assert.equal(jobKind('constructor'), null);
  assert.equal(jobKind('toString'), null);
  assert.equal(jobKind('./scripts/backup.sh'), null);
  assert.equal(insideRoot('/srv/aideation', 'backups'), '/srv/aideation/backups');
  assert.equal(insideRoot('/srv/aideation', '../etc'), null);
  assert.equal(insideRoot('/srv/aideation', '/etc'), null);
});

async function backupRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'scheduler-backup-'));
}

test('backup_check: fehlender Ordner → Fehlerstatus und Push über push_alert', async (t) => {
  const root = await backupRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const backup = job('backup_check', { config: { dir: 'backups' } });
  const alert = job('push_alert', { nextRunAt: new Date(Date.now() + HOUR) });
  const { pool } = fakePool([backup, alert]);
  const recorder = pushRecorder();
  const runs = await runDueJobs(pool, deps({ installRoot: root, push: recorder.push }));
  assert.equal(backup.lastStatus, 'failed');
  assert.match(backup.lastMessage!, /nicht erreichbar \(ENOENT\)/);
  assert.deepEqual(
    runs.map((run) => run.key),
    ['backup_check', 'push_alert'],
    'push_alert wird sofort fällig',
  );
  assert.equal(recorder.sent.length, 1);
  assert.match(recorder.sent[0]!.message.body, /backup_check: Backup-Ordner „backups“ nicht erreichbar/);
  assert.equal(alert.lastStatus, 'warning');
});

test('backup_check ohne push_alert: Push direkt an die Administratoren, beim Wechsel in „fehlgeschlagen“', async (t) => {
  const root = await backupRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const backup = job('backup_check');
  const { pool } = fakePool([backup]);
  const recorder = pushRecorder();
  await runDueJobs(pool, deps({ installRoot: root, push: recorder.push }));
  assert.equal(recorder.sent.length, 1);
  assert.deepEqual(recorder.sent[0]!.audience, {});
  // Schlägt er erneut fehl, kommt keine zweite Meldung.
  backup.nextRunAt = new Date(Date.now() - 1000);
  await runDueJobs(pool, deps({ installRoot: root, push: recorder.push }));
  assert.equal(recorder.sent.length, 1);
});

test('backup_check: frisch und gross genug ok; zu alt, zu klein, leer oder ausserhalb = Fehler', async (t) => {
  const root = await backupRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'backups'));
  const run = async (config: Record<string, unknown>) => {
    const row = job('backup_check', { config });
    await runDueJobs(fakePool([row]).pool, deps({ installRoot: root }));
    return row;
  };
  assert.match((await run({})).lastMessage!, /Kein Datenbank-Backup/);
  const file = join(root, 'backups', 'aideation-2026-10-20.dump');
  await writeFile(file, Buffer.alloc(2048));
  await writeFile(join(root, 'backups', 'notizen.txt'), 'kein Backup');
  const ok = await run({ minBytes: 1024, maxAgeHours: 26 });
  assert.equal(ok.lastStatus, 'ok', ok.lastMessage!);
  assert.match(ok.lastMessage!, /aideation-2026-10-20\.dump/);
  const small = await run({ minBytes: 4096 });
  assert.equal(small.lastStatus, 'failed');
  assert.match(small.lastMessage!, /zu klein/);
  const old = new Date(Date.now() - 30 * HOUR);
  await utimes(file, old, old);
  const stale = await run({ maxAgeHours: 26 });
  assert.equal(stale.lastStatus, 'failed');
  assert.match(stale.lastMessage!, /30 h alt/);
  const outside = await run({ dir: '../etc' });
  assert.equal(outside.lastStatus, 'failed');
  assert.match(outside.lastMessage!, /ausserhalb/);
});

test('watchdog_logs meldet dasselbe Problem nicht erneut vor Ablauf von REMIND_MS', async () => {
  const row = job('watchdog_logs');
  const { pool } = fakePool([row]);
  const recorder = pushRecorder();
  let problems = ['Worker meldet sich seit 9 Minuten nicht.'];
  const watchDeps = deps({ push: recorder.push, collectProblems: async () => ({ problems, dbOk: true }) });
  const again = async () => {
    row.nextRunAt = new Date(Date.now() - 1000);
    await runDueJobs(pool, watchDeps);
  };
  await again();
  assert.equal(recorder.sent.length, 1);
  assert.equal(row.lastStatus, 'warning');
  await again();
  assert.equal(recorder.sent.length, 1, 'innerhalb der Erinnerungsfrist still');
  assert.match(row.lastMessage!, /bereits gemeldet/);
  row.state = { ...row.state, notifiedAt: Date.now() - REMIND_MS - 1000 };
  await again();
  assert.equal(recorder.sent.length, 2, 'nach REMIND_MS erinnert');
  problems = [...problems, 'Nur noch 2.0 GB frei auf dem Projektlaufwerk.'];
  await again();
  assert.equal(recorder.sent.length, 3, 'neues Problem sofort');
  problems = [];
  await again();
  assert.equal(recorder.sent.length, 4, 'Erholung einmal');
  assert.equal(row.lastStatus, 'ok');
  await again();
  assert.equal(recorder.sent.length, 4);
});

test('watchdog_logs ruft keine Befehle auf: ohne installRoot im Wächter (kein git status)', async () => {
  const row = job('watchdog_logs', { config: { localUrl: 'http://127.0.0.1:9', backupDir: '../x' } });
  let options: Record<string, unknown> = {};
  await runDueJobs(
    fakePool([row]).pool,
    deps({
      installRoot: '/srv/aideation',
      collectProblems: async (given) => {
        options = given as unknown as Record<string, unknown>;
        return { problems: [], dbOk: true };
      },
    }),
  );
  assert.equal(options.installRoot, undefined);
  assert.equal(options.localUrl, 'http://127.0.0.1:9');
  assert.equal(options.backupDir, '/srv/aideation/backups', 'Pfad ausserhalb fällt auf den Standard zurück');
});

test('push_alert sendet über sendPush an den Projektkreis und entdoppelt', async () => {
  const failedJob = job('backup_check', {
    lastStatus: 'failed',
    lastMessage: 'Kein Datenbank-Backup',
    nextRunAt: new Date(Date.now() + HOUR),
  });
  const fineJob = job('watchdog_logs', { lastStatus: 'ok', nextRunAt: new Date(Date.now() + HOUR) });
  const alert = job('push_alert', { config: { project: 'shop', jobs: ['backup_check', 'watchdog_logs'] } });
  const { pool } = fakePool([failedJob, fineJob, alert]);
  const recorder = pushRecorder();
  await runDueJobs(pool, deps({ push: recorder.push }));
  assert.equal(recorder.sent.length, 1);
  assert.deepEqual(recorder.sent[0]!.audience, { project: 'shop' });
  assert.equal(recorder.sent[0]!.message.tag, 'scheduled-jobs');
  assert.match(recorder.sent[0]!.message.body, /backup_check: Kein Datenbank-Backup/);
  alert.nextRunAt = new Date(Date.now() - 1000);
  await runDueJobs(pool, deps({ push: recorder.push }));
  assert.equal(recorder.sent.length, 1, 'gleicher Fehlschlag nicht erneut');
  failedJob.lastStatus = 'ok';
  alert.nextRunAt = new Date(Date.now() - 1000);
  await runDueJobs(pool, deps({ push: recorder.push }));
  assert.equal(recorder.sent.length, 2, 'Entwarnung');
  assert.equal(alert.lastStatus, 'ok');
});

test('close_old_sprints schliesst nur abgearbeitete Sprints, nie solche mit offenen oder laufenden Aufträgen', async () => {
  const sprints = [
    { id: 'settled', project: 'shop', name: 'Sprint 3' },
    { id: 'open', project: 'shop', name: 'Sprint 4' },
    { id: 'running', project: 'blog', name: 'Sprint 1' },
  ];
  const items: Record<string, { status: string; actionTodo: string | null }[]> = {
    settled: [
      { status: 'done', actionTodo: null },
      { status: 'blocked', actionTodo: 'Zugang anlegen' },
    ],
    open: [
      { status: 'done', actionTodo: null },
      { status: 'planned', actionTodo: null },
    ],
    running: [{ status: 'in_progress', actionTodo: null }],
  };
  let candidateSql = '';
  let candidateValues: unknown[] = [];
  const row = job('close_old_sprints', { config: { inactiveDays: 7 } });
  const { pool } = fakePool([row], (sql, values) => {
    if (sql.includes('FROM sprints s')) {
      candidateSql = sql;
      candidateValues = values;
      return { rows: sprints };
    }
    if (sql.includes('FROM development_items')) return { rows: items[values[0] as string] ?? [] };
    return null;
  });
  const completed: string[] = [];
  const recorder = pushRecorder();
  await runDueJobs(
    pool,
    deps({
      push: recorder.push,
      completeSprint: async (_pool, id) => {
        completed.push(id);
      },
    }),
  );
  assert.deepEqual(completed, ['settled']);
  assert.equal(row.lastStatus, 'ok');
  assert.match(row.lastMessage!, /1 Sprint\(s\) abgeschlossen: shop: Sprint 3/);
  assert.deepEqual(candidateValues, [7, null]);
  assert.match(candidateSql, /status = 'active' AND s\.paused_at IS NULL/);
  assert.match(candidateSql, /NOT EXISTS .*r\.status = 'running'/s);
  assert.match(candidateSql, /make_interval\(days => \$1\)/);
  assert.deepEqual(recorder.sent[0]!.audience, { project: 'shop' });
});

test('close_old_sprints begrenzt die Schwelle auf 1–365 Tage', async () => {
  const values: unknown[][] = [];
  const row = job('close_old_sprints', { config: { inactiveDays: 100000, project: 'shop' } });
  const { pool } = fakePool([row], (sql, given) => {
    if (sql.includes('FROM sprints s')) {
      values.push(given);
      return { rows: [] };
    }
    return null;
  });
  await runDueJobs(pool, deps());
  assert.deepEqual(values[0], [365, 'shop']);
  assert.match(row.lastMessage!, /seit 365 Tagen/);
});
