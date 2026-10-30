import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { mock } from 'node:test';
import type { Pool } from 'pg';
import webpush from 'web-push';
import { type CommandExecutor, runCommand } from '../core/command.js';
import { processGitFix, syncGitState } from './git-state-sync.js';
import type { ProjectGitState } from './repo-state.js';
import { withMigratedDatabase } from '../db/test-database.test.js';

// VAPID-Schlüssel werden nur verschlüsselt gespeichert; dafür braucht es einen Schlüssel.
process.env.DEV_LOG_SECRET_KEY ??= 'ein-schluessel-nur-fuer-tests';

const env = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
};

/** Echtes git mit Test-Identität; zählt die Befehle, damit der Test das gelegentliche Holen sieht. */
function recordingExecutor(): { execute: CommandExecutor; commands: string[][] } {
  const commands: string[][] = [];
  const execute: CommandExecutor = (command, cwd, options) => {
    commands.push(command);
    return runCommand(command, cwd, { ...options, env: { ...env, ...options?.env } });
  };
  return { execute, commands };
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await runCommand(['git', ...args], cwd, { env });
  assert.equal(result.exitCode, 0, `git ${args.join(' ')}: ${result.output}`);
  return result.output.trim();
}

/** Remote („GitHub“), Projektordner auf main und ein Agent-Worktree auf einem eigenen Auftragsbranch. */
async function setup(): Promise<{ work: string; agents: string }> {
  const root = await mkdtemp(join(tmpdir(), 'git-state-sync-'));
  const remote = join(root, 'remote.git');
  const work = join(root, 'work');
  const agents = join(root, 'agents');
  await git(root, 'init', '-q', '--bare', '-b', 'main', remote);
  await git(root, 'clone', '-q', remote, work);
  await writeFile(join(work, 'a.txt'), 'a\n');
  await git(work, 'add', 'a.txt');
  await git(work, 'commit', '-q', '-m', 'eins');
  await git(work, 'push', '-q', 'origin', 'main');
  await git(work, 'worktree', 'add', '-q', '-b', 'auftrag/login', agents);
  return { work, agents };
}

async function runningAgent(pool: Pool, project: string): Promise<string> {
  const order = (
    await pool.query<{ id: string }>(
      `INSERT INTO development_items (project_slug, title, status) VALUES ($1, 'Läuft', 'in_progress') RETURNING id`,
      [project],
    )
  ).rows[0]!.id;
  const run = (
    await pool.query<{ id: string }>(
      `INSERT INTO agent_runs (project_slug, development_id, status) VALUES ($1, $2, 'running') RETURNING id`,
      [project, order],
    )
  ).rows[0]!.id;
  await pool.query(
    `INSERT INTO agent_run_steps (run_id, position, agent_name, phase, status)
     VALUES ($1, 1, 'Entwickler', 'while_task', 'running')`,
    [run],
  );
  return run;
}

const storedState = async (pool: Pool, project: string): Promise<ProjectGitState | null> =>
  (await pool.query('SELECT state FROM project_git_graphs WHERE project_slug = $1', [project])).rows[0]?.state ?? null;

const codes = (state: ProjectGitState | null): string[] =>
  (state?.problems ?? []).map((problem) => `${problem.role}:${problem.code}:${problem.severity}`);

test('Git-Zustand auf PostgreSQL: erfassen, Sperren melden, Lösungen ausführen', async (t) => {
  await withMigratedDatabase(t, 'devlog_git_state_sync', async (db) => {
    const pool = db as unknown as Pool;
    await pool.query(`INSERT INTO projects (slug, name, repository) VALUES
      ('velo', 'Velowerk', '/srv/velo'), ('getrennt', 'Getrennt', '/srv/getrennt')`);
    // Ein Gerät des Systemadmins: Er bekommt die Meldungen aller Projekte.
    await pool.query(
      `INSERT INTO push_subscriptions (endpoint, p256dh, auth, user_id, system_admin)
       VALUES ('https://fcm.googleapis.com/fcm/send/admin', 'BKey', 'AuthKey', NULL, TRUE)`,
    );
    const send = mock.method(webpush, 'sendNotification', async () => ({ statusCode: 201, body: '', headers: {} }));
    const pushedTitles = () =>
      send.mock.calls.map((call) => (JSON.parse(String(call.arguments[1])) as { title: string }).title);
    t.after(() => send.mock.restore());

    await t.test(
      'Agents arbeiten im Projektordner: ein Ordner, sauber, Stand von GitHub nur gelegentlich',
      async (sub) => {
        const { work } = await setup();
        const { execute, commands } = recordingExecutor();
        const state = await syncGitState(pool, 'velo', work, work, execute);
        assert.deepEqual(
          state.folders.map((folder) => [folder.role, folder.branch]),
          [['live', 'main']],
        );
        assert.deepEqual(state.problems, []);
        assert.deepEqual(await storedState(pool, 'velo'), state);
        const fetches = () => commands.filter((command) => command.includes('fetch')).length;
        assert.equal(fetches(), 1);
        await syncGitState(pool, 'velo', work, work, execute);
        assert.equal(fetches(), 1, 'innerhalb von 10 Minuten nicht erneut holen');
        assert.equal(send.mock.callCount(), 0);

        await sub.test('neue Sperre wird einmal gemeldet, nicht bei jeder Erfassung', async () => {
          await writeFile(join(work, 'a.txt'), 'geändert\n');
          const dirty = await syncGitState(pool, 'velo', work, work, execute);
          assert.deepEqual(codes(dirty), ['live:uncommitted:block']);
          assert.deepEqual(pushedTitles(), ['⚠️ Git-Zustand prüfen · velo']);
          await syncGitState(pool, 'velo', work, work, execute);
          assert.equal(send.mock.callCount(), 1);
          // Eine neue Datei kommt dazu: im Ordner der Agents sperrend und damit eine neue Meldung.
          await writeFile(join(work, 'neu.txt'), 'neu\n');
          assert.deepEqual(codes(await syncGitState(pool, 'velo', work, work, execute)), [
            'live:uncommitted:block',
            'live:untracked:block',
          ]);
          assert.equal(send.mock.callCount(), 2);
        });

        await sub.test('läuft ein Agent, sind offene Änderungen seine Arbeit und kein Befund', async () => {
          const run = await runningAgent(pool, 'velo');
          assert.deepEqual(codes(await syncGitState(pool, 'velo', work, work, execute)), []);
          await pool.query('DELETE FROM agent_runs WHERE id = $1', [run]);
        });
      },
    );

    await t.test('Erste Erfassung meldet nichts, auch wenn schon etwas sperrt', async () => {
      const { work, agents } = await setup();
      const before = send.mock.callCount();
      await writeFile(join(agents, 'a.txt'), 'halb fertig\n');
      const state = await syncGitState(pool, 'getrennt', work, agents);
      assert.deepEqual(
        state.folders.map((folder) => [folder.role, folder.branch]),
        [
          ['live', 'main'],
          ['agents', 'auftrag/login'],
        ],
      );
      assert.deepEqual(codes(state), ['agents:uncommitted:block']);
      assert.equal(send.mock.callCount(), before);
    });

    await t.test('Lösungen: nichts angefordert, neben laufendem Auftrag zurückgestellt, sonst ausgeführt', async () => {
      const { work, agents } = await setup();
      const { execute } = recordingExecutor();
      await syncGitState(pool, 'velo', work, agents, execute);
      assert.equal(await processGitFix(pool, 'velo', work, agents, execute), false);

      await writeFile(join(work, 'a.txt'), 'auf main geändert\n');
      const requested = (
        await pool.query<{ id: string }>(
          `INSERT INTO git_fix_requests (project_slug, fix, role) VALUES ('velo', 'save_wip', 'live') RETURNING id`,
        )
      ).rows[0]!.id;
      const status = async (id: string) =>
        (await pool.query('SELECT status, message, finished_at FROM git_fix_requests WHERE id = $1', [id])).rows[0];

      const run = await runningAgent(pool, 'velo');
      assert.equal(await processGitFix(pool, 'velo', work, agents, execute), false);
      assert.equal((await status(requested)).status, 'requested', 'Commit träfe sonst die Arbeit des Auftrags');
      await pool.query('DELETE FROM agent_runs WHERE id = $1', [run]);

      const pushesBefore = send.mock.callCount();
      assert.equal(await processGitFix(pool, 'velo', work, agents, execute), true);
      const done = await status(requested);
      assert.equal(done.status, 'done');
      assert.match(done.message, /auf wip\/\d{8}-\d{4} gesichert/);
      assert.ok(done.finished_at);
      assert.equal(await git(work, 'status', '--porcelain'), '', 'Projektordner ist wieder sauber');
      assert.deepEqual(codes(await storedState(pool, 'velo')), [], 'Zustand sofort neu erfasst');
      assert.equal(pushedTitles()[pushesBefore], '✓ Zwischenstand sichern · velo');
    });

    await t.test('Fehlgeschlagene Lösung im Agent-Ordner: Status „failed“ mit Grund, Warnung per Push', async () => {
      const { work, agents } = await setup();
      await writeFile(join(agents, 'a.txt'), 'vom Agent geändert\n');
      const requested = (
        await pool.query<{ id: string }>(
          `INSERT INTO git_fix_requests (project_slug, fix, role) VALUES ('getrennt', 'checkout_main', 'agents')
           RETURNING id`,
        )
      ).rows[0]!.id;
      const pushesBefore = send.mock.callCount();
      assert.equal(await processGitFix(pool, 'getrennt', work, agents), true);
      const row = (await pool.query('SELECT status, message FROM git_fix_requests WHERE id = $1', [requested])).rows[0];
      assert.equal(row.status, 'failed');
      assert.match(row.message, /Änderungen offen/);
      // Ausgeführt im Agent-Ordner: Der steht weiter auf seinem Branch, der Projektordner bleibt auf main.
      assert.equal(await git(agents, 'symbolic-ref', '--short', 'HEAD'), 'auftrag/login');
      assert.equal(await git(work, 'symbolic-ref', '--short', 'HEAD'), 'main');
      assert.equal(pushedTitles()[pushesBefore], '⚠️ Zurück auf main · getrennt');
      // Erledigt: der nächste Aufruf hat nichts mehr zu tun.
      assert.equal(await processGitFix(pool, 'getrennt', work, agents), false);
    });
  });
});
