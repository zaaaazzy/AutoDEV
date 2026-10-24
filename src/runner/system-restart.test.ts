import assert from 'node:assert/strict';
import test from 'node:test';
import type { CommandExecutor } from '../core/command.js';
import {
  completeRestart,
  composeEnvironment,
  DEPENDENCY_COMMAND,
  dependenciesOutdated,
  processRestart,
  pullBranch,
  readRestart,
  requestRestart,
  RESTART_COMMAND,
  RESTARTING_STALE_MS,
} from './system-restart.js';

/** app_settings im Speicher: genug für SELECT value … WHERE key und INSERT … ON CONFLICT. */
function memoryPool() {
  const rows = new Map<string, string>();
  return {
    rows,
    query: async (sql: string, values: unknown[] = []) => {
      if (sql.startsWith('SELECT')) {
        const value = rows.get(String(values[0]));
        return { rows: value === undefined ? [] : [{ value }] };
      }
      rows.set(String(values[0]), String(values[1]));
      return { rows: [] };
    },
  } as unknown as Parameters<typeof readRestart>[0] & { rows: Map<string, string> };
}

/** Git im Arbeitsordner: Branch main, nichts geändert – sonst die Ausgabe von docker compose. */
const ok: CommandExecutor = async (command) => ({
  exitCode: 0,
  durationMs: 1,
  output: command[0] === 'git' ? (command[1] === 'rev-parse' ? 'main\n' : '') : 'Container dev-log Started',
});

test('Neustart: anfordern, Container neu bauen, nach dem Worker-Start abschließen', async () => {
  const pool = memoryPool();
  const calls: { command: string[]; cwd: string }[] = [];
  const execute: CommandExecutor = async (command, cwd) => {
    calls.push({ command, cwd });
    return ok(command, cwd);
  };
  assert.equal(await processRestart(pool, '/srv/devlog', () => 0, execute), 'idle');
  const first = await requestRestart(pool, 'Patrick');
  assert.equal(first.created, true);
  assert.equal((await requestRestart(pool, 'jemand')).created, false, 'kein zweiter Neustart parallel');
  assert.equal(
    await processRestart(pool, '/srv/devlog', () => 0, execute, undefined, { health: async () => true }),
    'restart',
  );
  assert.deepEqual(
    calls.filter((call) => call.command.includes('--build')),
    [{ command: RESTART_COMMAND, cwd: '/srv/devlog' }],
  );
  assert.equal((await readRestart(pool))?.status, 'restarting');
  assert.equal((await completeRestart(pool))?.status, 'done');
  assert.equal((await requestRestart(pool, 'Patrick')).created, true, 'nach Abschluss wieder möglich');
});

test('Neustart: kommt der Worker nicht wieder, bleibt „restarting“ nicht für immer gesperrt', async () => {
  const pool = memoryPool();
  const requested = new Date('2026-10-21T10:00:00Z');
  await requestRestart(pool, 'Patrick', requested);
  const built = new Date(requested.getTime() + 3 * 60_000);
  assert.equal(
    await processRestart(
      pool,
      '/x',
      () => 0,
      ok,
      () => built,
      { health: async () => true },
    ),
    'restart',
  );
  assert.equal((await readRestart(pool))?.restartingAt, built.toISOString());
  const soon = new Date(built.getTime() + RESTARTING_STALE_MS - 1_000);
  assert.equal((await requestRestart(pool, 'Patrick', soon)).created, false, 'kurz danach: 409');
  const late = new Date(built.getTime() + RESTARTING_STALE_MS + 1_000);
  const again = await requestRestart(pool, 'Patrick', late);
  assert.equal(again.created, true, 'nach dem Grenzwert: neuer Neustart möglich');
  assert.equal(again.state.status, 'requested');
});

test('Neustart: „requested“ und „building“ sperren unabhängig vom Alter', async () => {
  const pool = memoryPool();
  const requested = new Date('2026-10-21T10:00:00Z');
  await requestRestart(pool, null, requested);
  const late = new Date(requested.getTime() + 2 * RESTARTING_STALE_MS);
  assert.equal((await requestRestart(pool, null, late)).created, false);
});

test('Neustart: wartet auf laufende Aufgaben, aber nicht unbegrenzt', async () => {
  const pool = memoryPool();
  const requested = new Date('2026-10-19T10:00:00Z');
  await requestRestart(pool, null, requested);
  const soon = () => new Date(requested.getTime() + 60_000);
  assert.equal(await processRestart(pool, '/x', () => 2, ok, soon), 'waiting');
  assert.match((await readRestart(pool))?.message ?? '', /Wartet auf 2 laufende Aufgaben/);
  const late = () => new Date(requested.getTime() + 16 * 60_000);
  assert.equal(await processRestart(pool, '/x', () => 2, ok, late, { health: async () => true }), 'restart');
});

test('Neustart: fehlgeschlagener Build lässt den Worker weiterlaufen und meldet die Ausgabe', async () => {
  const pool = memoryPool();
  await requestRestart(pool, null);
  const failing: CommandExecutor = async (command, cwd) =>
    command[0] === 'git' ? ok(command, cwd) : { exitCode: 1, durationMs: 1, output: 'failed to solve: npm ci' };
  assert.equal(await processRestart(pool, '/x', () => 0, failing), 'failed');
  const state = await readRestart(pool);
  assert.equal(state?.status, 'failed');
  assert.match(state?.log ?? '', /npm ci/);
  // Ein Worker-Start nach einem abgebrochenen Build markiert diesen als fehlgeschlagen.
  pool.rows.set('system:restart', JSON.stringify({ ...state, status: 'building' }));
  assert.equal((await completeRestart(pool))?.status, 'failed');
});

test('Neustart: Kommentar aus der Bestätigung wird gespeichert', async () => {
  const pool = memoryPool();
  const { state } = await requestRestart(pool, 'Patrick', new Date(), '  neue Agents laden ');
  assert.equal(state.comment, 'neue Agents laden');
});

test('Neustart: antwortet der neue Stand nicht, wird auf das vorherige Abbild zurückgesetzt', async () => {
  const pool = memoryPool();
  const calls: string[][] = [];
  const execute: CommandExecutor = async (command) => {
    calls.push(command);
    if (command.includes('images'))
      return {
        exitCode: 0,
        durationMs: 1,
        output: '[{"ID":"sha256:abc","Repository":"devlog-dev-log","Tag":"latest"}]',
      };
    return ok(command, '/x');
  };
  await requestRestart(pool, 'Patrick');
  let checks = 0;
  // Erst nach dem Zurücksetzen antwortet AIdeation wieder.
  const health = async (): Promise<boolean> => calls.some((call) => call.includes('--no-build')) && ++checks > 0;
  const result = await processRestart(pool, '/srv', () => 0, execute, undefined, {
    health,
    healthTimeoutMs: 0,
    healthIntervalMs: 0,
  });
  assert.equal(result, 'failed');
  assert.ok(calls.some((call) => call.join(' ') === 'docker tag sha256:abc devlog-dev-log:latest'));
  const state = await readRestart(pool);
  assert.match(state?.message ?? '', /vorherigen Abbild/);
});

test('Neustart: meldet das Ende per Benachrichtigung, Erfolg wie Fehlschlag, Zwischenstände nicht', async () => {
  const pool = memoryPool();
  const seen: string[] = [];
  const notify = async (_pool: unknown, state: { status: string }) => {
    seen.push(state.status);
  };
  await requestRestart(pool, 'Patrick');
  await processRestart(pool, '/x', () => 0, ok, undefined, { health: async () => true, notify });
  assert.deepEqual(seen, [], 'building und restarting melden nichts');
  await completeRestart(pool, new Date(), notify);
  assert.deepEqual(seen, ['done']);

  await requestRestart(pool, null);
  const failing: CommandExecutor = async (command, cwd) =>
    command[0] === 'git' ? ok(command, cwd) : { exitCode: 1, durationMs: 1, output: 'failed to solve' };
  await processRestart(pool, '/x', () => 0, failing, undefined, { notify });
  assert.deepEqual(seen, ['done', 'failed']);
  // Ohne laufenden Neustart meldet ein Worker-Start nichts.
  await completeRestart(pool, new Date(), notify);
  assert.deepEqual(seen, ['done', 'failed']);
});

test('Neustart: baut nur einen sauberen Stand des erlaubten Branches', async () => {
  const gitState =
    (branch: string, status: string): CommandExecutor =>
    async (command, cwd) =>
      command[0] === 'git'
        ? { exitCode: 0, durationMs: 1, output: command[1] === 'rev-parse' ? `${branch}\n` : status }
        : ok(command, cwd);
  const run = async (execute: CommandExecutor, branch?: string) => {
    const pool = memoryPool();
    await requestRestart(pool, 'Patrick');
    const result = await processRestart(pool, '/x', () => 0, execute, undefined, { health: async () => true, branch });
    return { result, message: (await readRestart(pool))?.message ?? '' };
  };
  const feature = await run(gitState('fix/irgendwas', ''));
  assert.equal(feature.result, 'failed');
  assert.match(feature.message, /„fix\/irgendwas“ ausgecheckt, live gehen darf nur „main“/);
  const dirty = await run(gitState('main', ' M src/server.ts\n'));
  assert.equal(dirty.result, 'failed');
  assert.match(dirty.message, /Nicht committete Änderungen im AIdeation-Ordner \(src\/server\.ts\)/);
  assert.equal((await run(gitState('fix/irgendwas', ''), '*')).result, 'restart', '„*“ erlaubt jeden Branch');
  assert.equal((await run(gitState('release', ''), 'release')).result, 'restart');
});

/** Git mit Remote „origin“: rev-parse HEAD liefert erst `before`, nach dem Merge `after`; fetch/merge wie angegeben. */
function remoteGit(options: { fetch?: number; merge?: number; before?: string; after?: string } = {}) {
  const calls: string[][] = [];
  let merged = false;
  const execute: CommandExecutor = async (command, cwd) => {
    calls.push(command);
    if (command[0] !== 'git') return ok(command, cwd);
    const result = (exitCode: number, output = '') => ({ exitCode, durationMs: 1, output });
    switch (command[1]) {
      case 'remote':
        return result(0, 'origin\n');
      case 'rev-parse':
        if (command[2] === '--abbrev-ref') return result(0, 'main\n');
        return result(0, `${merged ? (options.after ?? 'a'.repeat(40)) : (options.before ?? 'a'.repeat(40))}\n`);
      case 'fetch':
        return result(
          options.fetch ?? 0,
          options.fetch ? 'ssh: connect to host github.com: Network is unreachable' : '',
        );
      case 'merge':
        merged = (options.merge ?? 0) === 0;
        return result(options.merge ?? 0, options.merge ? 'fatal: Not possible to fast-forward, aborting.' : '');
      default:
        return result(0);
    }
  };
  return { calls, execute };
}

test('Neustart: holt vor dem Bau den neuesten Stand per Fast-Forward von origin', async () => {
  const git = remoteGit({ before: '1111111aaaa', after: '2222222bbbb' });
  const pool = memoryPool();
  await requestRestart(pool, 'Patrick');
  const result = await processRestart(pool, '/x', () => 0, git.execute, undefined, { health: async () => true });
  assert.equal(result, 'restart');
  const order = git.calls.map((command) => command.slice(0, 2).join(' '));
  assert.ok(order.indexOf('git fetch') < order.indexOf('git merge'), 'erst holen, dann vorspulen');
  assert.ok(order.indexOf('git merge') < order.indexOf('docker compose'), 'vor dem Bau');
  assert.deepEqual(
    git.calls.find((command) => command[1] === 'merge'),
    ['git', 'merge', '--ff-only', 'FETCH_HEAD'],
  );
  assert.match((await readRestart(pool))?.log ?? '', /^Neuester Stand von origin\/main geholt \(1111111 → 2222222\)/);
});

test('pullBranch: offline, abweichender Stand oder kein Remote baut den lokalen Stand', async () => {
  assert.match(await pullBranch('/x', remoteGit({ fetch: 128 }).execute), /GitHub nicht erreichbar.*lokale Stand/);
  assert.match(await pullBranch('/x', remoteGit({ merge: 128 }).execute), /kein Fast-Forward möglich.*lokale Stand/);
  assert.match(await pullBranch('/x', remoteGit().execute), /war schon aktuell/);
  assert.match(await pullBranch('/x', ok), /Kein Remote „origin“/);
});

test('Neustart: ohne Netz wird trotzdem gebaut', async () => {
  const pool = memoryPool();
  await requestRestart(pool, 'Patrick');
  const git = remoteGit({ fetch: 128 });
  assert.equal(
    await processRestart(pool, '/x', () => 0, git.execute, undefined, { health: async () => true }),
    'restart',
  );
  assert.ok(git.calls.some((command) => command.includes('--build')));
  assert.ok(!git.calls.some((command) => command[1] === 'merge'), 'ohne fetch kein merge');
});

test('Neustart: unsauberer Ordner wird gar nicht erst aktualisiert', async () => {
  const pool = memoryPool();
  await requestRestart(pool, 'Patrick');
  const calls: string[][] = [];
  const dirty: CommandExecutor = async (command) => {
    calls.push(command);
    return { exitCode: 0, durationMs: 1, output: command[1] === 'rev-parse' ? 'main\n' : ' M src/server.ts\n' };
  };
  assert.equal(await processRestart(pool, '/x', () => 0, dirty), 'failed');
  assert.ok(!calls.some((command) => command[1] === 'fetch' || command[1] === 'merge'));
});

test('Neustart scheitert schon vor dem Bau (falscher Branch): genau eine Benachrichtigung', async () => {
  const pool = memoryPool();
  const seen: string[] = [];
  const notify = async (_pool: unknown, state: { status: string }) => {
    seen.push(state.status);
  };
  await requestRestart(pool, 'Patrick');
  const feature: CommandExecutor = async (command, cwd) =>
    command[0] === 'git' && command[1] === 'rev-parse'
      ? { exitCode: 0, durationMs: 1, output: 'fix/irgendwas\n' }
      : ok(command, cwd);
  assert.equal(await processRestart(pool, '/x', () => 0, feature, undefined, { notify, branch: 'main' }), 'failed');
  assert.deepEqual(seen, ['failed']);
});

test('Neustart und Rollback: Compose läuft ohne DEV_LOG_*/COMPOSE_* aus der Worker-Umgebung, damit die .env gilt', async () => {
  const keys = ['DEV_LOG_SECRET_KEY', 'DEV_LOG_PROJECT_ROOTS', 'COMPOSE_PROJECT_NAME', 'AIDEATION_TEST_MARKER'];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  // Worker ohne Schlüssel installiert: leerer Wert würde bei Compose die .env überdecken.
  process.env.DEV_LOG_SECRET_KEY = '';
  process.env.DEV_LOG_PROJECT_ROOTS = '/platzhalter/projekte';
  process.env.COMPOSE_PROJECT_NAME = 'platzhalter';
  process.env.AIDEATION_TEST_MARKER = 'bleibt';
  try {
    const pool = memoryPool();
    const calls: { command: string[]; env: NodeJS.ProcessEnv | undefined }[] = [];
    const execute: CommandExecutor = async (command, cwd, options) => {
      calls.push({ command, env: options?.env });
      if (command.includes('images'))
        return {
          exitCode: 0,
          durationMs: 1,
          output: '[{"ID":"sha256:abc","Repository":"devlog-dev-log","Tag":"latest"}]',
        };
      return ok(command, cwd);
    };
    await requestRestart(pool, 'Patrick');
    // Der neue Stand antwortet nie: Neubau und Rollback werden beide ausgeführt.
    const result = await processRestart(pool, '/srv', () => 0, execute, undefined, {
      health: async () => false,
      healthTimeoutMs: 0,
      healthIntervalMs: 0,
    });
    assert.equal(result, 'failed');
    const compose = calls.filter((call) => call.command[1] === 'compose');
    assert.deepEqual(
      compose.map((call) => call.command.slice(2, 4).join(' ')),
      ['images dev-log', 'up -d', 'up -d'],
      'images, Neubau und Rollback',
    );
    assert.ok(compose.some((call) => call.command.join(' ') === RESTART_COMMAND.join(' ')));
    assert.ok(compose.some((call) => call.command.includes('--no-build')));
    for (const call of compose) {
      assert.ok(call.env, `${call.command.join(' ')} bekommt eine eigene Umgebung`);
      const leaked = Object.keys(call.env).filter((key) => /^(DEV_LOG|COMPOSE)_/i.test(key));
      assert.deepEqual(leaked, [], `${call.command.join(' ')} ohne DEV_LOG_*/COMPOSE_*`);
      assert.equal(call.env.AIDEATION_TEST_MARKER, 'bleibt', 'übrige Umgebung (PATH, DOCKER_HOST …) bleibt');
    }
    // Gegenprobe: docker tag liest keine .env und läuft unverändert.
    const tag = calls.find((call) => call.command[1] === 'tag');
    assert.ok(tag);
    assert.equal(tag.env, undefined);
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});

/** Lockfile im Installationsordner und (optional) das versteckte Lockfile, das npm in node_modules schreibt. */
function lockfiles(lockfile: object, installed: object | null) {
  return async (path: string) =>
    path === '/srv/package-lock.json'
      ? JSON.stringify(lockfile)
      : path === '/srv/node_modules/.package-lock.json' && installed
        ? JSON.stringify(installed)
        : null;
}

const LOCK = {
  packages: {
    '': { name: 'dev-log', dependencies: { neu: '^1.0.0' } },
    'node_modules/pg': { version: '8.16.3' },
    'node_modules/neu': { version: '1.0.0' },
    'node_modules/@esbuild/linux-x64': { version: '0.25.0', optional: true },
  },
};
const INSTALLED_OLD = { packages: { 'node_modules/pg': { version: '8.16.3' } } };
const INSTALLED_NEW = {
  packages: { 'node_modules/pg': { version: '8.16.3' }, 'node_modules/neu': { version: '1.0.0' } },
};

test('Neustart: abweichendes Lockfile – npm ci --ignore-scripts auf dem Host vor dem Neubau, danach „done“', async () => {
  const saved = process.env.DEV_LOG_SECRET_KEY;
  process.env.DEV_LOG_SECRET_KEY = 'platzhalter';
  try {
    for (const installed of [INSTALLED_OLD, null]) {
      const pool = memoryPool();
      const calls: { command: string[]; cwd: string; env: NodeJS.ProcessEnv | undefined }[] = [];
      const execute: CommandExecutor = async (command, cwd, options) => {
        calls.push({ command, cwd, env: options?.env });
        return ok(command, cwd);
      };
      await requestRestart(pool, 'Patrick');
      const result = await processRestart(pool, '/srv', () => 0, execute, undefined, {
        health: async () => true,
        readText: lockfiles(LOCK, installed),
      });
      assert.equal(result, 'restart', installed ? 'veraltete node_modules' : 'node_modules/.package-lock.json fehlt');
      const npm = calls.findIndex((call) => call.command.join(' ') === DEPENDENCY_COMMAND.join(' '));
      assert.ok(npm >= 0, 'npm ci läuft');
      assert.deepEqual(DEPENDENCY_COMMAND, ['npm', 'ci', '--ignore-scripts']);
      assert.equal(calls[npm].cwd, '/srv');
      assert.ok(calls[npm].env, 'eigene Umgebung');
      assert.equal(calls[npm].env.DEV_LOG_SECRET_KEY, undefined, 'ohne DEV_LOG_* (composeEnvironment)');
      assert.ok(npm < calls.findIndex((call) => call.command.includes('--build')), 'vor dem Neubau');
      assert.equal((await completeRestart(pool))?.status, 'done');
    }
  } finally {
    if (saved === undefined) delete process.env.DEV_LOG_SECRET_KEY;
    else process.env.DEV_LOG_SECRET_KEY = saved;
  }
});

test('Neustart: passendes Lockfile – kein npm ci', async () => {
  const pool = memoryPool();
  const calls: string[][] = [];
  const execute: CommandExecutor = async (command, cwd) => {
    calls.push(command);
    return ok(command, cwd);
  };
  await requestRestart(pool, 'Patrick');
  const result = await processRestart(pool, '/srv', () => 0, execute, undefined, {
    health: async () => true,
    readText: lockfiles(LOCK, INSTALLED_NEW),
  });
  assert.equal(result, 'restart');
  assert.ok(!calls.some((call) => call[0] === 'npm'), 'fremde optionale Pakete lösen keine Installation aus');
});

test('Neustart: npm ci scheitert – „failed“, kein Neubau, Worker beendet sich nicht, nächster Neustart möglich', async () => {
  const pool = memoryPool();
  const seen: string[] = [];
  const calls: string[][] = [];
  const execute: CommandExecutor = async (command, cwd) => {
    calls.push(command);
    return command[0] === 'npm'
      ? { exitCode: 1, durationMs: 1, output: 'npm error code ETARGET neu@1.0.0' }
      : ok(command, cwd);
  };
  await requestRestart(pool, 'Patrick');
  const result = await processRestart(pool, '/srv', () => 0, execute, undefined, {
    health: async () => true,
    readText: lockfiles(LOCK, INSTALLED_OLD),
    notify: async (_pool, state) => {
      seen.push(state.status);
    },
  });
  assert.equal(result, 'failed');
  assert.ok(!calls.some((call) => call.includes('--build')), 'Container werden nicht neu gebaut');
  const state = await readRestart(pool);
  assert.equal(state?.status, 'failed');
  assert.match(state?.message ?? '', /npm ci --ignore-scripts ist fehlgeschlagen \(Exit-Code 1\)/);
  assert.match(state?.log ?? '', /ETARGET/);
  assert.deepEqual(seen, ['failed'], 'Push-Meldung');
  assert.equal((await requestRestart(pool, 'Patrick')).created, true, 'kein 409 beim nächsten Versuch');
});

test('dependenciesOutdated: Versionen, fehlende und überzählige Pakete, kaputtes JSON', () => {
  const lock = JSON.stringify(LOCK);
  assert.equal(dependenciesOutdated(lock, JSON.stringify(INSTALLED_NEW)), false);
  assert.equal(dependenciesOutdated(lock, JSON.stringify(INSTALLED_OLD)), true);
  assert.equal(dependenciesOutdated(lock, null), true);
  assert.equal(dependenciesOutdated(lock, '{kaputt'), true);
  const older = { packages: { ...INSTALLED_NEW.packages, 'node_modules/neu': { version: '0.9.0' } } };
  assert.equal(dependenciesOutdated(lock, JSON.stringify(older)), true);
  const extra = { packages: { ...INSTALLED_NEW.packages, 'node_modules/alt': { version: '1.0.0' } } };
  assert.equal(dependenciesOutdated(lock, JSON.stringify(extra)), true);
});

test('composeEnvironment: entfernt DEV_LOG_* und COMPOSE_* (auch leere Werte), lässt den Rest', () => {
  const env = composeEnvironment({
    PATH: '/usr/bin',
    DOCKER_HOST: 'unix:///platzhalter.sock',
    DEV_LOG_SECRET_KEY: '',
    DEV_LOG_DOMAIN: '',
    COMPOSE_FILE: 'anderes.yml',
  });
  assert.deepEqual(env, { PATH: '/usr/bin', DOCKER_HOST: 'unix:///platzhalter.sock' });
});

test('Drain: solange ein Neustart angefordert ist oder gebaut wird, startet der Worker keine neue Arbeit', async () => {
  const { acceptsNewWork } = await import('./system-restart.js');
  assert.equal(acceptsNewWork(null), true);
  assert.equal(acceptsNewWork({ status: 'requested' }), false);
  assert.equal(acceptsNewWork({ status: 'building' }), false);
  assert.equal(acceptsNewWork({ status: 'restarting' }), true);
  assert.equal(acceptsNewWork({ status: 'done' }), true);
  assert.equal(acceptsNewWork({ status: 'failed' }), true);
});
