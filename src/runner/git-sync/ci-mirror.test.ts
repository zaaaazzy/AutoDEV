import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Pool } from 'pg';
import type { CommandExecutor, CommandResult } from '../../core/command.js';
import { ciMirrorBugTitle, mirroredSteps, reportCiMirrorFailure, runCiMirror } from './ci-mirror.js';

const WORKFLOW = `name: CI
jobs:
  check:
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: npm run lint
      - run: npm run format:check
      # Kommentar
      - run: npm run typecheck
      - run: npm run test:unit
  e2e:
    steps:
      - run: npm ci
      - run: npx --no-install playwright install --with-deps chromium
      - run: npm run build:ui
      - run: npm run test:e2e
      - run: npm run lint
  docker:
    steps:
      - name: Zugangsdaten
        run: |
          echo hallo
      - run: docker compose build dev-log frontend https
      - run: docker build deploy/review
      - run: npx --no-install tsx --test src/core/sandbox-docker.test.ts
`;

async function projectWith(workflow: string | null): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'ci-mirror-'));
  if (workflow !== null) {
    await mkdir(join(cwd, '.github', 'workflows'), { recursive: true });
    await writeFile(join(cwd, '.github', 'workflows', 'ci.yml'), workflow);
  }
  return cwd;
}

/** Zeichnet Befehle und Environment auf; die Antwort je Skript (`npm run <skript>`) ist vorgegeben. */
function recorder(results: Record<string, Partial<CommandResult>> = {}) {
  const calls: { command: string[]; env: NodeJS.ProcessEnv | undefined }[] = [];
  const execute: CommandExecutor = async (command, _cwd, options) => {
    calls.push({ command, env: options?.env });
    return { exitCode: 0, durationMs: 1, output: '', ...results[command[2] ?? ''] };
  };
  return { calls, execute };
}

test('CI-Spiegel: erkennt genau die vier npm-run-Schritte in der Reihenfolge der Datei', () => {
  assert.deepEqual(mirroredSteps(WORKFLOW), [
    ['npm', 'run', 'lint'],
    ['npm', 'run', 'format:check'],
    ['npm', 'run', 'typecheck'],
    ['npm', 'run', 'test:unit'],
  ]);
  // Reihenfolge folgt der Datei, nicht einer Liste im Code; Anführungszeichen und Kommentare stören nicht.
  const quoted = `steps:
  - run: 'npm run test:unit'
  - run: npm run lint # schnell
  - run: npm run build:ui
`;
  assert.deepEqual(mirroredSteps(quoted), [
    ['npm', 'run', 'test:unit'],
    ['npm', 'run', 'lint'],
  ]);
});

test('CI-Spiegel: npm ci, Docker-, Playwright- und E2E-Schritte werden nicht ausgeführt', async () => {
  const cwd = await projectWith(WORKFLOW);
  const { calls, execute } = recorder();
  const log: string[] = [];
  assert.equal(await runCiMirror(execute, cwd, log), null);
  const commands = calls.map((call) => call.command.join(' '));
  assert.deepEqual(commands, ['npm run lint', 'npm run format:check', 'npm run typecheck', 'npm run test:unit']);
  for (const command of commands) assert.ok(!/npm ci|docker|playwright|test:e2e|build:ui/.test(command), command);
  assert.match(log.at(-1)!, /CI-Spiegel grün \(lint, format:check, typecheck, test:unit\)/);
});

test('CI-Spiegel: liest die Workflow-Datei bei jedem Lauf neu', async () => {
  const cwd = await projectWith('steps:\n  - run: npm run lint\n');
  const first = recorder();
  await runCiMirror(first.execute, cwd, []);
  await writeFile(join(cwd, '.github', 'workflows', 'ci.yml'), 'steps:\n  - run: npm run typecheck\n');
  const second = recorder();
  await runCiMirror(second.execute, cwd, []);
  assert.deepEqual(
    first.calls.map((call) => call.command[2]),
    ['lint'],
  );
  assert.deepEqual(
    second.calls.map((call) => call.command[2]),
    ['typecheck'],
  );
});

test('CI-Spiegel: ohne ci.yml übersprungen, nichts ausgeführt', async () => {
  const cwd = await projectWith(null);
  const { calls, execute } = recorder();
  const log: string[] = [];
  assert.equal(await runCiMirror(execute, cwd, log), null);
  assert.equal(calls.length, 0);
  assert.match(log[0]!, /CI-Spiegel übersprungen/);
});

test('CI-Spiegel: hält beim ersten roten Schritt an, ohne Zugangsdaten, Auszug höchstens 3000 Zeichen', async (t) => {
  // Echter Schlüssel, den die Allowlist von runProjectCommand filtern muss.
  const secret = 'ci-mirror-geheim-0123456789abcdef';
  const previous = process.env.DEV_LOG_SECRET_KEY;
  process.env.DEV_LOG_SECRET_KEY = secret;
  t.after(() => {
    if (previous === undefined) delete process.env.DEV_LOG_SECRET_KEY;
    else process.env.DEV_LOG_SECRET_KEY = previous;
  });
  const cwd = await projectWith(WORKFLOW);
  // Zur Laufzeit zusammengesetzt, damit die Datei selbst kein Token-Format enthält.
  const token = `ghp_${'a1'.repeat(18)}`;
  const noise = Array.from({ length: 200 }, (_, index) => `Zeile ${index} ${'x'.repeat(40)}`).join('\n');
  const { calls, execute } = recorder({
    'format:check': {
      exitCode: 1,
      output: `${noise}\n[warn] src/a.ts\nDEV_LOG_SECRET_KEY=${secret}\nGITHUB_TOKEN=${token}\n`,
    },
  });
  const failure = await runCiMirror(execute, cwd, []);
  assert.ok(failure);
  assert.equal(failure.step, 'npm run format:check');
  assert.equal(failure.exitCode, 1);
  // Nach dem roten Schritt läuft nichts mehr.
  assert.deepEqual(
    calls.map((call) => call.command[2]),
    ['lint', 'format:check'],
  );
  for (const call of calls) {
    assert.ok(call.env, 'Environment gesetzt (nicht process.env)');
    assert.equal(call.env.DEV_LOG_SECRET_KEY, undefined);
    assert.ok(!Object.values(call.env).includes(secret));
  }
  assert.ok(failure.excerpt.length <= 3000, `Auszug ${failure.excerpt.length} Zeichen`);
  assert.ok(failure.excerpt.split('\n').length <= 60);
  assert.ok(!failure.excerpt.includes(secret));
  assert.ok(!failure.excerpt.includes(token));
  assert.ok(!failure.summary.includes(secret));
  assert.match(failure.excerpt, /\[warn\] src\/a\.ts/);
});

test('CI-Spiegel: ohne erreichbare Datenbank ist test:unit „nicht prüfbar“, nicht rot', async () => {
  const cwd = await projectWith(WORKFLOW);
  const { execute } = recorder({
    'test:unit': {
      exitCode: 1,
      output:
        'not ok 3 - migrations\n  Error: keine PostgreSQL-Datenbank unter localhost:5432 (DEV_LOG_TEST_REQUIRE_DATABASE)\n',
    },
  });
  const log: string[] = [];
  assert.equal(await runCiMirror(execute, cwd, log), null);
  assert.ok(log.some((entry) => /`npm run test:unit` nicht prüfbar/.test(entry)));
  assert.equal(log.at(-1), 'CI-Spiegel grün (lint, format:check, typecheck).');
});

test('CI-Spiegel: Datenbank-Hinweis gilt nur für test:unit, andere Schritte bleiben rot', async () => {
  const cwd = await projectWith(WORKFLOW);
  const { execute } = recorder({ lint: { exitCode: 2, output: 'connect ECONNREFUSED 127.0.0.1:5432' } });
  assert.equal((await runCiMirror(execute, cwd, []))?.step, 'npm run lint');
});

test('CI-Spiegel: genau ein offener Bug pro Sprint und Schritt (Titel, Priorität high, Quelle github)', async () => {
  const bugs: { title: string; description: string }[] = [];
  const pool = {
    query: async (sql: string, values: unknown[] = []) => {
      assert.match(sql, /'high', 'github'/);
      const [, title, description, marker] = values.map(String);
      if (bugs.some((bug) => bug.title === title && bug.description.includes(marker!))) return { rows: [] };
      bugs.push({ title: title!, description: description! });
      return { rows: [{ id: String(bugs.length) }] };
    },
  } as unknown as Pool;
  const failure = { step: 'npm run lint', exitCode: 1, excerpt: 'error  no-unused-vars', summary: '' };
  assert.equal(await reportCiMirrorFailure(pool, 'p', 'Sprint 1: Äpfel', failure), true);
  assert.equal(await reportCiMirrorFailure(pool, 'p', 'Sprint 1: Äpfel', failure), false);
  const typecheck = { ...failure, step: 'npm run typecheck' };
  assert.equal(await reportCiMirrorFailure(pool, 'p', 'Sprint 1: Äpfel', typecheck), true);
  assert.equal(bugs.length, 2);
  assert.equal(bugs[0]!.title, 'CI-Spiegel rot vor Pull Request von „Sprint 1: Äpfel“');
  assert.match(bugs[0]!.description, /Fehlgeschlagener Schritt: `npm run lint`/);
  assert.match(bugs[0]!.description, /no-unused-vars/);
  assert.ok(ciMirrorBugTitle('x'.repeat(400)).length <= 180);
  // Die Bereinigung in migrations.ts erfasst nur „CI rot im Pull Request von …“.
  assert.ok(!ciMirrorBugTitle('S').startsWith('CI rot im Pull Request von'));
});
