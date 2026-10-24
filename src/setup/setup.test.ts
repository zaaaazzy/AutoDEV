import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Pool } from 'pg';
import { agentCommand } from '../api/setup.js';
import { processSetupJob, whichCommand } from './setup-jobs.js';
import type { CommandExecutor } from '../core/command.js';
import { TEMPLATES } from './templates.js';

// Unabhängig vom Projektbereich der Umgebung (der Worker setzt ihn, z. B. im Test-Gate).
delete process.env.DEV_LOG_PROJECT_ROOTS;

function jobPool(kind: string, params: Record<string, unknown>) {
  const updates: { sql: string; values: unknown[] }[] = [];
  let claimed = false;
  const pool = {
    query: async (sql: string, values: unknown[] = []) => {
      updates.push({ sql, values });
      if (sql.includes("SET status = 'running'") && !claimed) {
        claimed = true;
        return { rows: [{ id: 'job-1', kind, params }] };
      }
      return { rows: [] };
    },
  } as unknown as Pool;
  return { pool, updates };
}

test('templates have unique ids and every non-custom template does something', () => {
  const ids = TEMPLATES.map((template) => template.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const template of TEMPLATES.filter((entry) => entry.id !== 'custom')) {
    assert.ok(template.files || template.commands?.length, template.id);
  }
  assert.ok(TEMPLATES.filter((template) => template.group === 'featured').length >= 3);
});

test('agent commands per provider', () => {
  assert.deepEqual(agentCommand('claude', 'opus'), [
    'claude',
    '--model',
    'opus',
    '--permission-mode',
    'acceptEdits',
    '-p',
    '{prompt}',
  ]);
  assert.equal(agentCommand('ollama', ''), null);
  assert.equal(agentCommand('gemini', '')?.[2], 'gemini-2.5-pro');
});

test('check_folder reports existence, emptiness and git state on the host', async () => {
  const root = await mkdtemp(join(tmpdir(), 'setup-'));
  const folder = join(root, 'projekt');
  const missing = jobPool('check_folder', { path: folder });
  assert.equal(await processSetupJob(missing.pool), true);
  const done = missing.updates.find((update) => update.sql.includes("status = 'done'"));
  assert.deepEqual(JSON.parse(String(done?.values[1])), { exists: false, isDirectory: false, empty: true, git: null });

  const created = jobPool('create_folder', { path: folder });
  await processSetupJob(created.pool);
  await writeFile(join(folder, 'a.txt'), 'x');
  const filled = jobPool('check_folder', { path: folder });
  await processSetupJob(filled.pool);
  const result = JSON.parse(String(filled.updates.find((update) => update.sql.includes("status = 'done'"))?.values[1]));
  assert.equal(result.exists, true);
  assert.equal(result.empty, false);
  assert.equal(result.git.isRepo, false);
});

test('folders outside the allowed area are rejected', async () => {
  const { pool, updates } = jobPool('check_folder', { path: '/etc' });
  await processSetupJob(pool);
  assert.ok(updates.some((update) => update.sql.includes("status = 'failed'")));
});

test('Programmsuche ohne /bin/sh unter Windows', () => {
  assert.deepEqual(whichCommand('gh', 'win32'), ['where', 'gh']);
  assert.deepEqual(whichCommand('gh', 'darwin'), ['/bin/sh', '-c', 'command -v gh']);
  assert.deepEqual(whichCommand('gh', 'linux'), ['/bin/sh', '-c', 'command -v gh']);
});

test('eigene Vorlage wird ohne Shell in den Projektordner übernommen', async () => {
  const folder = join(await mkdtemp(join(tmpdir(), 'setup-')), 'projekt');
  const commands: string[][] = [];
  // Ersetzt `git clone`: legt den Klon mit .git und einem Unterordner an.
  const execute: CommandExecutor = async (command) => {
    commands.push(command);
    const target = command.at(-1)!;
    await mkdir(join(target, '.git'), { recursive: true });
    await mkdir(join(target, 'src'), { recursive: true });
    await writeFile(join(target, 'README.md'), 'Vorlage');
    await writeFile(join(target, 'src', 'index.ts'), 'export {};');
    return { exitCode: 0, durationMs: 0, output: '' };
  };
  const { pool, updates } = jobPool('apply_template', {
    path: folder,
    template: 'custom',
    templateUrl: 'https://github.com/zaaaazzy/Vorlage.git',
  });
  await processSetupJob(pool, execute);
  assert.ok(
    updates.some((update) => update.sql.includes("status = 'done'")),
    JSON.stringify(updates.at(-2)),
  );
  assert.deepEqual(
    commands.map((command) => command[0]),
    ['git'],
  );
  assert.deepEqual((await readdir(folder)).sort(), ['README.md', 'src']);
  assert.equal(await readFile(join(folder, 'src', 'index.ts'), 'utf8'), 'export {};');
});
