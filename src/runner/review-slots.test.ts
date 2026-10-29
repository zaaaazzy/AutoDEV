import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Pool } from 'pg';
import type { CommandExecutor } from '../core/command.js';
import {
  containerEnvProblem,
  exitCause,
  DATABASE_COPY_SCRIPT,
  REVIEW_DATABASE_SCRIPT,
  ReviewSlots,
  reviewDatabase,
  reviewNpmVolume,
  reviewPort,
  reviewSlotDatabase,
  reviewUrl,
} from './review-slots.js';
import { orderOf, parseSprintLog } from './sprint-commits.js';

test('Review-Container: Port und Adresse je Nummer', () => {
  assert.equal(reviewPort(1), 4201);
  assert.equal(reviewUrl(3), 'http://localhost:4203');
});

test('Datenbank-Kopie je Container, aus Docker über host.docker.internal erreichbar', () => {
  const copy = reviewDatabase('postgresql://mainty:geheim@127.0.0.1:5432/mainty', 2);
  assert.equal(copy?.source.toString(), 'postgresql://mainty:geheim@host.docker.internal:5432/mainty');
  assert.equal(copy?.target.toString(), 'postgresql://mainty:geheim@host.docker.internal:5432/mainty_review_2');
  assert.equal(reviewDatabase('postgresql://db.example:5432/app', 1)?.target.hostname, 'db.example');
  assert.equal(reviewDatabase('kein url', 1), null);
});

test('Sprint-Stände: Git-Log lesen und Auftrag aus dem Merge erkennen', () => {
  const hash = 'a'.repeat(40);
  const log = `${hash}\x1fMerge auftrag/1a2b3c4d-liste: Liste\x1f2026-10-19T20:00:00+02:00\x1e\nkaputt\x1e`;
  assert.deepEqual(parseSprintLog(log), [
    { hash, subject: 'Merge auftrag/1a2b3c4d-liste: Liste', date: '2026-10-19T20:00:00+02:00' },
  ]);
  const items = [{ id: '1a2b3c4d-0000-0000-0000-000000000000' }, { id: 'ffffffff-0000-0000-0000-000000000000' }];
  assert.equal(orderOf('Merge auftrag/1a2b3c4d-liste: Liste', items), items[0]!.id);
  assert.equal(orderOf('feat: ohne Auftrag', items), null);
});

/** Führt das Kopier-Skript mit Platzhaltern für die Postgres-Werkzeuge aus; liefert Exit-Code und psql-Aufrufe. */
async function runCopyScript(dumpExit: number, psqlExit = 0): Promise<{ status: number | null; psql: string }> {
  const bin = await mkdtemp(join(tmpdir(), 'review-db-'));
  const log = join(bin, 'psql.log');
  const tool = async (name: string, body: string) => {
    await writeFile(join(bin, name), `#!/bin/sh\n${body}\n`);
    await chmod(join(bin, name), 0o755);
  };
  await tool('dropdb', 'exit 0');
  await tool('createdb', 'exit 0');
  await tool('pg_dump', `[ ${dumpExit} -eq 0 ] && echo 'CREATE TABLE a ();' > "$3"; exit ${dumpExit}`);
  await tool('psql', `echo "$@" >> '${log}'; exit ${psqlExit}`);
  const result = spawnSync('sh', ['-c', DATABASE_COPY_SCRIPT], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, S_DB: 'quelle', T_DB: 'ziel' },
  });
  return { status: result.status, psql: await readFile(log, 'utf8').catch(() => '') };
}

test('Datenbank-Kopie: gescheiterter pg_dump lässt die Kopie scheitern statt eine leere Datenbank zu melden', async () => {
  const failed = await runCopyScript(1);
  assert.notEqual(failed.status, 0);
  assert.equal(failed.psql, '', 'psql spielt nach einem gescheiterten Dump nichts ein');
  const sqlError = await runCopyScript(0, 3);
  assert.notEqual(sqlError.status, 0);
  assert.match(sqlError.psql, /ON_ERROR_STOP=1/);
  const ok = await runCopyScript(0);
  assert.equal(ok.status, 0);
  assert.match(ok.psql, /-d ziel -f /);
});

/** Abnahme-Stand mit den Branches `branches` (Name → Commit) und optional einem laufenden Sprint. */
async function acceptance(sprint: string | null, branches: Record<string, string>): Promise<string | null> {
  const pool = {
    query: async () => ({ rows: sprint ? [{ name: sprint }] : [] }),
  } as unknown as Pool;
  const execute: CommandExecutor = async (command) => {
    const ref = String(command.at(-1)).replace('refs/heads/', '');
    const hash = branches[ref];
    return { exitCode: hash ? 0 : 1, durationMs: 1, output: hash ?? '' };
  };
  return new ReviewSlots(pool, '/install', execute).acceptanceCommit('auftrag', '/projekt');
}

test('Abnahme im Review-Container: Sprint-Branch des laufenden Sprints, sonst main', async () => {
  const main = 'm'.repeat(40);
  const sprint = 's'.repeat(40);
  assert.equal(await acceptance('Sprint 8', { 'sprint/sprint-8': sprint, main }), sprint);
  assert.equal(await acceptance('Sprint 8', { main }), main, 'Sprint-Branch fehlt: main');
  assert.equal(await acceptance(null, { main }), main, 'ohne laufenden Sprint: main');
  assert.equal(await acceptance(null, {}), null);
});

const MAIN_PASSWORD = 'haupt-geheim-123';
const MAIN_URL = `postgresql://devlog:${MAIN_PASSWORD}@localhost:5433/aideation`;
const REVIEW_URL = 'postgresql://aideation_review:review-pw@localhost:5433/aideation_review';

/** Startet Slot 1 für `slug` über sync(), mit Fakes für Datenbank und Docker; liefert Aufrufe und Slot-Updates. */
async function startSlot(options: {
  databases: { reviewUrl: string | null; mainUrl: string | null };
  slug?: string;
  projectDatabaseUrl?: string | null;
}): Promise<{ commands: string[][]; updates: unknown[][]; run: string[] | undefined }> {
  const commands: string[][] = [];
  const updates: unknown[][] = [];
  const slot = {
    slot: 1,
    enabled: true,
    projectSlug: options.slug ?? 'aideation',
    commit: 'c'.repeat(40),
    label: 'Vorschau',
    developmentId: null,
    kind: 'manual',
    status: 'requested',
    startedAt: null,
  };
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      if (sql.startsWith('UPDATE review_slots')) updates.push(params);
      if (sql.includes('FROM review_slots')) return { rows: [slot] };
      if (sql.includes('FROM projects')) {
        return {
          rows: [
            {
              folder: '/projekte/aideation',
              command: ['sh', '/source/deploy/review/aideation-review.sh'],
              databaseUrl: options.projectDatabaseUrl ?? null,
            },
          ],
        };
      }
      return { rows: [] };
    },
  } as unknown as Pool;
  const execute: CommandExecutor = async (command) => {
    commands.push(command);
    const output = command.includes('--git-common-dir') ? '/projekte/aideation/.git\n' : '';
    return { exitCode: 0, durationMs: 1, output };
  };
  await new ReviewSlots(pool, '/install', execute, async () => false, options.databases).sync();
  const run = commands.find((command) => command[1] === 'run' && command[2] === '-d');
  return { commands, updates, run };
}

/** Meldung des Updates auf „failed“ (Parameter: Slot, Status, Meldung). */
function failure(updates: unknown[][]): string {
  const failed = updates.find((params) => params[1] === 'failed');
  return String(failed?.[2] ?? '');
}

test('Review-Container: keine .env, kein Projektordner, keine Haupt-Zugänge und keine DB „postgres“ im Container', async () => {
  const { commands, run } = await startSlot({ databases: { reviewUrl: REVIEW_URL, mainUrl: MAIN_URL } });
  assert.ok(run, 'docker run wurde aufgerufen');
  const args = run.join('\n');
  const mounts = run.flatMap((arg, index) => (run[index - 1] === '-v' ? [arg] : []));
  assert.deepEqual(mounts, [
    '/projekte/aideation/.git/objects:/source/objects:ro',
    'aideation_review_npm_aideation:/home/node/.npm',
  ]);
  assert.ok(!mounts.some((mount) => mount.startsWith('/projekte/aideation:')), 'Projektordner nicht eingebunden');
  assert.ok(!args.includes('.env'), 'keine .env');
  assert.ok(!args.includes(MAIN_PASSWORD), 'kein Haupt-DB-Passwort');
  assert.ok(!/\/postgres\b/.test(args), 'keine Verbindung zur DB postgres');
  assert.ok(!args.includes('devlog:'), 'kein Haupt-DB-User');
  assert.ok(!args.includes('/root/'), 'kein root-Cache');
  assert.equal(run[run.indexOf('--user') + 1], 'node');
  assert.ok(run.includes('no-new-privileges'));
  const env = run.flatMap((arg, index) => (run[index - 1] === '-e' ? [arg] : []));
  assert.ok(
    env.includes(
      'REVIEW_DATABASE_URL=postgresql://aideation_review:review-pw@host.docker.internal:5433/aideation_review_1',
    ),
  );
  assert.ok(env.includes('REVIEW_COMMAND=sh /work/deploy/review/aideation-review.sh'));
  // Die Slot-Datenbank legt der Review-User in seiner Basis-Datenbank an, nicht über „postgres“.
  const create = commands.find((command) => command.includes('postgres:17-alpine'));
  assert.ok(create?.includes('R_BASE=aideation_review'));
  assert.ok(create?.includes('R_DB=aideation_review_1'));
  assert.ok(!create?.join('\n').includes(MAIN_PASSWORD));
});

test('Review-Container: ohne Review-DB-User scheitert der Start vor jedem docker run', async () => {
  for (const reviewUrl of [null, '', 'postgresql://aideation_review:pw@localhost:5433/postgres']) {
    const { commands, updates } = await startSlot({ databases: { reviewUrl, mainUrl: MAIN_URL } });
    assert.ok(!commands.some((command) => command[0] === 'docker'), 'kein Docker-Aufruf');
    assert.match(failure(updates), /DEV_LOG_REVIEW_DATABASE_URL/);
  }
});

test('Review-Container: Haupt-User oder Haupt-Passwort als Review-User werden abgelehnt', async () => {
  for (const reviewUrl of [
    'postgresql://devlog:anders@localhost:5433/aideation_review',
    `postgresql://jemand:${MAIN_PASSWORD}@localhost:5433/aideation_review`,
    'postgresql://jemand:anders@localhost:5433/aideation',
  ]) {
    const { commands, updates } = await startSlot({ databases: { reviewUrl, mainUrl: MAIN_URL } });
    assert.ok(!commands.some((command) => command[0] === 'docker'), 'kein Docker-Aufruf');
    assert.match(failure(updates), /eigener User/);
  }
});

test('Review-Container: Projekt-Datenbank mit Haupt-Zugängen gelangt nicht in den Container', async () => {
  const { commands, updates } = await startSlot({
    databases: { reviewUrl: REVIEW_URL, mainUrl: MAIN_URL },
    projectDatabaseUrl: MAIN_URL,
  });
  assert.ok(!commands.some((command) => command[0] === 'docker'), 'weder Kopie noch docker run');
  assert.match(failure(updates), /Haupt-DB-Passwort/);
  assert.ok(!failure(updates).includes(MAIN_PASSWORD));
});

test('Review-Container: npm-Cache je Projekt getrennt', async () => {
  const databases = { reviewUrl: REVIEW_URL, mainUrl: MAIN_URL };
  const first = (await startSlot({ databases, slug: 'aideation' })).run?.join('\n') ?? '';
  const second = (await startSlot({ databases, slug: 'mainty' })).run?.join('\n') ?? '';
  assert.match(first, /aideation_review_npm_aideation:/);
  assert.match(second, /aideation_review_npm_mainty:/);
  assert.equal(reviewNpmVolume('Mein Projekt/x'), 'aideation_review_npm_mein_projekt_x');
});

test('Review-Container: Env-Prüfung erkennt Haupt-Passwort, Haupt-User und DB postgres', () => {
  assert.equal(containerEnvProblem(['A=1', `DATABASE_URL=${REVIEW_URL}`], MAIN_URL), null);
  assert.match(String(containerEnvProblem([`X=${MAIN_PASSWORD}`], MAIN_URL)), /Passwort/);
  assert.match(String(containerEnvProblem(['DB=postgresql://devlog:x@h/db'], MAIN_URL)), /User/);
  assert.match(String(containerEnvProblem(['DB=postgresql://r:x@h:5433/postgres'], MAIN_URL)), /postgres/);
  assert.equal(typeof reviewSlotDatabase({ reviewUrl: REVIEW_URL, mainUrl: null }, 2), 'object');
});

/** Führt REVIEW_DATABASE_SCRIPT mit einem nachgebauten psql aus; owner = Besitzer, den die Besitzer-Abfrage meldet. */
async function runSlotDatabaseScript(owner: string) {
  const bin = await mkdtemp(join(tmpdir(), 'review-slotdb-'));
  const log = join(bin, 'psql.log');
  // Existenz-Abfrage liefert nichts (also wird angelegt), die Besitzer-Abfrage den vorgegebenen Besitzer.
  await writeFile(
    join(bin, 'psql'),
    `#!/bin/sh\necho "$PGDATABASE|$*" >> '${log}'\ncase "$*" in *datdba*) echo '${owner}' ;; esac\nexit 0\n`,
  );
  await chmod(join(bin, 'psql'), 0o755);
  const result = spawnSync('sh', ['-c', REVIEW_DATABASE_SCRIPT], {
    env: {
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      R_USER: 'aideation_review',
      R_BASE: 'aideation_review',
      R_DB: 'aideation_review_3',
    },
    encoding: 'utf8',
  });
  return { result, calls: (await readFile(log, 'utf8')).trim().split('\n') };
}

test('Review-Datenbank anlegen: nur über die eigene Basis-Datenbank, nie über „postgres“', async () => {
  const { result, calls } = await runSlotDatabaseScript('aideation_review');
  assert.equal(result.status, 0);
  assert.equal(calls.length, 3);
  assert.ok(calls.every((call) => call.startsWith('aideation_review|')));
  assert.match(calls[1]!, /CREATE DATABASE aideation_review_3/);
  assert.ok(!calls.join('\n').includes('postgres'));
});

test('Review-Datenbank eines anderen Users: klare Meldung statt „permission denied for schema public“', async () => {
  const { result } = await runSlotDatabaseScript('devlog');
  assert.equal(result.status, 1);
  assert.match(result.stdout, /aideation_review_3 gehört „devlog“, nicht dem Review-User „aideation_review“/);
  assert.match(result.stdout, /dropdb aideation_review_3/);
});

test('Beendeter Review-Container: die Ursache steht in der ersten Zeile der Meldung', () => {
  const mainty = [
    '[review] Backend auf :3000',
    'Warning: This is a simple server for use in testing or debugging Angular applications',
    'Backend startup failed: Error: Bootstrap-Administrator benötigt einen gültigen Benutzernamen.',
    '    at bootstrapAdministrator (/work/backend/src/modules/auth/auth.service.ts:144:11)',
    '[review] 15:46:45 Ein Server ist beendet.',
  ].join('\n');
  assert.equal(
    exitCause(mainty),
    'Backend startup failed: Error: Bootstrap-Administrator benötigt einen gültigen Benutzernamen.',
  );
  assert.equal(exitCause('npm error code ERESOLVE\nnpm error ERESOLVE could not resolve'), 'npm error code ERESOLVE');
  assert.equal(exitCause('[review] Start\n[review] alles gut'), null);
});
