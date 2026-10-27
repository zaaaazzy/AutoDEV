import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Pool } from 'pg';
import { agentCommand, templateProjectColumns } from '../api/setup.js';
import { processSetupJob, whichCommand } from './setup-jobs.js';
import type { CommandExecutor } from '../core/command.js';
import { findTemplate, folderFiles, GENERATORS, PHASER_DEV_URL, TEMPLATES } from './templates.js';

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

test('Vorlagen: Generatoren mit fester Version, Installationen ohne Install-Skripte', () => {
  const commands = TEMPLATES.flatMap((template) => (template.commands ?? []).map((command) => ({ template, command })));
  for (const { template, command } of commands) {
    const line = `${template.id}: ${command.join(' ')}`;
    assert.ok(!command.some((word) => /@(latest|next)$/.test(word)), line);
    // Paket für npx/npm create: genaue Version, kein Bereich wie @20.
    const generator =
      command[0] === 'npx' && command[1] === '-y' ? command[2] : command[1] === 'create' ? command[3] : null;
    if (generator) assert.match(generator, /^(@[\w-]+\/)?[\w-]+@\d+\.\d+\.\d+$/, line);
    if (command[0] === 'npm' && command.some((word) => ['install', 'i', 'ci'].includes(word))) {
      assert.ok(command.includes('--ignore-scripts'), line);
    }
    // Generatoren, die sonst selbst installieren, überlassen das dem eigenen Schritt mit --ignore-scripts.
    if (generator && /angular\/cli|create-next-app|nestjs\/cli/.test(generator)) {
      assert.ok(command.includes('--skip-install'), line);
    }
    if (generator?.startsWith('nuxi@')) assert.ok(command.includes('--no-install'), line);
  }
  for (const id of ['angular', 'angular-node-postgres', 'nextjs', 'nestjs', 'react-vite', 'nuxt']) {
    const steps = findTemplate(id)!.commands!;
    assert.ok(steps.at(-1)!.includes('--ignore-scripts'), `${id}: zuletzt npm install --ignore-scripts`);
  }
  assert.ok(Object.values(GENERATORS).every((spec) => /@\d+\.\d+\.\d+$/.test(spec)));
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

test('Ordner-Vorlage: Dateien mit Unterordnern, Platzhalter für Projekt- und Paketnamen', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vorlagen-'));
  await mkdir(join(root, 'spiel', 'src', 'logic'), { recursive: true });
  await writeFile(join(root, 'spiel', 'package.json'), '{"name":"__PACKAGE_NAME__"}');
  await writeFile(join(root, 'spiel', 'src', 'logic', 'a.ts'), '// __PROJECT_NAME__');
  await writeFile(join(root, 'spiel', '.DS_Store'), 'x');
  assert.deepEqual(folderFiles('spiel', 'Mein Spiel: Äpfel!', root), [
    { path: 'package.json', content: '{"name":"mein-spiel-apfel"}' },
    { path: 'src/logic/a.ts', content: '// Mein Spiel: Äpfel!' },
  ]);
  assert.equal(folderFiles('spiel', '!!!', root)[0]?.content, '{"name":"projekt"}');
});

test('Phaser-Vorlage: Vite, TypeScript, Phaser 3, Tests und Agent-Richtlinien', () => {
  const template = findTemplate('phaser-game');
  assert.equal(template?.group, 'featured');
  const files = new Map(template!.files!('Sternenjagd').map((file) => [file.path, file.content]));
  for (const path of [
    '.gitignore',
    'package.json',
    'index.html',
    'vite.config.ts',
    'tsconfig.json',
    'playwright.config.ts',
    'src/main.ts',
    'src/scenes/main-scene.ts',
    'src/logic/game-state.ts',
    'src/logic/game-state.test.ts',
    'e2e/smoke.spec.ts',
    'README.md',
    'AGENTS.md',
    'CLAUDE.md',
  ]) {
    assert.ok(files.has(path), path);
  }
  for (const [path, content] of files) assert.doesNotMatch(content, /__(PROJECT|PACKAGE)_NAME__/, path);
  const pkg = JSON.parse(files.get('package.json')!);
  assert.equal(pkg.name, 'sternenjagd');
  assert.match(pkg.dependencies.phaser, /^\^3\./, 'Phaser 3, nicht 4');
  for (const script of ['dev', 'build', 'test', 'test:smoke', 'review']) assert.ok(pkg.scripts[script], script);
  assert.match(pkg.devDependencies.vite, /^\^\d/);
  // Gleiche Playwright-Version wie AIdeation: der schon installierte Chromium passt.
  assert.equal(pkg.devDependencies['@playwright/test'], '1.64.1');
  assert.match(files.get('AGENTS.md')!, /Spiellogik von Phaser-Szenen trennen/);
  assert.match(files.get('README.md')!, /^# Sternenjagd/);
  assert.match(files.get('.gitignore')!, /test-results\//);
  // Die Spiellogik kommt ohne Phaser aus, sonst wäre sie im Node-Prozess nicht testbar.
  assert.doesNotMatch(files.get('src/logic/game-state.ts')!, /from 'phaser'/);
  // Review-Container: Host und Port kommen aus REVIEW_HOST/REVIEW_FRONTEND_PORT, der Dev-Server auf der Vorschau-Adresse.
  assert.match(files.get('vite.config.ts')!, /REVIEW_FRONTEND_PORT/);
  // Dev-Server im Netzwerk erreichbar (Handy, Tablet), wie der Dev-Server von mainty.
  assert.match(files.get('vite.config.ts')!, /server: \{ host: true,/);
  assert.match(files.get('vite.config.ts')!, new RegExp(`GAME_DEV_PORT \\?\\? ${new URL(PHASER_DEV_URL).port}\\)`));
});

test('Phaser-Vorlage wird angewendet: Dateien, npm install und Chromium für den Smoke-Test', async () => {
  const folder = join(await mkdtemp(join(tmpdir(), 'setup-')), 'spiel');
  const commands: string[][] = [];
  const ignoreScripts: (string | undefined)[] = [];
  const execute: CommandExecutor = async (command, _cwd, options) => {
    commands.push(command);
    ignoreScripts.push(options?.env?.npm_config_ignore_scripts);
    return { exitCode: 0, durationMs: 0, output: '' };
  };
  const { pool, updates } = jobPool('apply_template', { path: folder, template: 'phaser-game', name: 'Sternenjagd' });
  await processSetupJob(pool, execute);
  assert.ok(updates.some((update) => update.sql.includes("status = 'done'")));
  assert.deepEqual(commands, [
    ['npm', 'install', '--ignore-scripts', '--no-audit', '--no-fund'],
    ['npx', '--no-install', 'playwright', 'install', 'chromium'],
  ]);
  // Auch Befehle ohne eigene Option (und npm-Aufrufe der Generatoren) laufen ohne Install-Skripte.
  assert.deepEqual(ignoreScripts, ['true', 'true']);
  assert.match(await readFile(join(folder, 'src', 'scenes', 'main-scene.ts'), 'utf8'), /extends Phaser\.Scene/);
  assert.equal(JSON.parse(await readFile(join(folder, 'package.json'), 'utf8')).name, 'sternenjagd');
});

test('Vorlage belegt Testbefehle, Review-Befehl, Vorschau-Adresse und Regeln vor', () => {
  assert.deepEqual(templateProjectColumns(undefined), []);
  assert.deepEqual(templateProjectColumns('gibt-es-nicht'), []);
  assert.deepEqual(templateProjectColumns('empty'), []);
  const columns = new Map(templateProjectColumns('phaser-game').map((entry) => [entry.column, entry]));
  assert.deepEqual(
    [...columns.keys()],
    ['test_commands', 'order_test_commands', 'review_command', 'preview_url', 'guidelines'],
  );
  assert.deepEqual(JSON.parse(String(columns.get('test_commands')?.value)), [
    ['npm', 'run', 'build'],
    ['npm', 'test'],
    ['npm', 'run', 'test:smoke'],
  ]);
  assert.ok(JSON.parse(String(columns.get('order_test_commands')?.value)).some((c: string[]) => c.includes('{tests}')));
  assert.equal(columns.get('review_command')?.cast, '::jsonb');
  assert.deepEqual(JSON.parse(String(columns.get('review_command')?.value)), ['npm', 'run', 'review']);
  assert.deepEqual(columns.get('preview_url'), { column: 'preview_url', value: PHASER_DEV_URL, cast: '' });
  assert.match(String(columns.get('guidelines')?.value), /src\/logic/);
});
