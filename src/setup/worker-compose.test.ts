import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  CREDENTIAL_TARGETS,
  detectCredentials,
  OVERRIDE_FILE,
  OVERRIDE_MARKER,
  workerContainerPath,
  workerOverride,
  workerRoots,
  writeWorkerOverride,
} from './worker-compose.js';

/** Block eines Dienstes aus der erzeugten Datei. */
const block = (yaml: string, service: string): string =>
  yaml.split(new RegExp(`^ {2}${service}:\\n`, 'm'))[1]?.split(/^ {2}\S/m)[0] ?? '';

test('Worker-Compose: AIdeation-Ordner und Projektordner mit demselben Pfad wie auf dem Host (macOS/Linux)', () => {
  const yaml = workerOverride({
    installDir: '/Volumes/Daten/Coding/AIdeation',
    projectRoots: '/Volumes/Daten/Coding:/home/du/Projekte/',
    platform: 'darwin',
  });
  assert.ok(yaml.startsWith(OVERRIDE_MARKER));
  const worker = block(yaml, 'worker');
  assert.match(worker, /working_dir: "\/Volumes\/Daten\/Coding\/AIdeation"/);
  assert.match(worker, /DEV_LOG_INSTALL_DIR: "\/Volumes\/Daten\/Coding\/AIdeation"/);
  assert.match(worker, /DEV_LOG_PROJECT_ROOTS: "\/Volumes\/Daten\/Coding:\/home\/du\/Projekte"/);
  for (const path of ['/Volumes/Daten/Coding/AIdeation', '/Volumes/Daten/Coding', '/home/du/Projekte'])
    assert.ok(worker.includes(`source: "${path}"\n        target: "${path}"\n`), path);
  // node_modules als Volume über dem eingebundenen Ordner (Linux-Binärdateien).
  assert.match(
    worker,
    /source: aideation_worker_modules\n {8}target: "\/Volumes\/Daten\/Coding\/AIdeation\/node_modules"/,
  );
});

test('Worker-Compose: unter Windows gilt der Pfad von Docker Desktop', () => {
  assert.equal(workerContainerPath('C:\\Users\\du\\AIdeation\\', 'win32'), '/c/Users/du/AIdeation');
  const yaml = workerOverride({
    installDir: 'C:\\Users\\du\\AIdeation',
    projectRoots: 'D:\\Projekte;C:\\Users\\du\\Code',
    platform: 'win32',
  });
  const worker = block(yaml, 'worker');
  assert.ok(worker.includes('source: "C:\\\\Users\\\\du\\\\AIdeation"\n        target: "/c/Users/du/AIdeation"'));
  assert.ok(worker.includes('source: "D:\\\\Projekte"\n        target: "/d/Projekte"'));
  assert.match(worker, /DEV_LOG_PROJECT_ROOTS: "\/d\/Projekte:\/c\/Users\/du\/Code"/);
  assert.match(worker, /DEV_LOG_INSTALL_DIR: "\/c\/Users\/du\/AIdeation"/);
});

test('Worker-Compose: ohne Projektbereich der Ordner, in dem AIdeation liegt; verschachtelte Ordner nur einmal', () => {
  assert.deepEqual(workerRoots('/srv/coding/aideation', '', 'linux'), ['/srv/coding']);
  assert.deepEqual(workerRoots('/srv/x', '/srv/coding:/srv/coding/app:/srv/coding/', 'linux'), ['/srv/coding']);
  assert.deepEqual(workerRoots('C:\\a', 'C:\\Code;c:\\code\\app', 'win32'), ['C:\\Code']);
});

test('Worker-Compose: Git-Zugänge nur im Worker und schreibgeschützt, kein Docker-Socket, Wächter nur lesend', () => {
  const yaml = workerOverride({
    installDir: '/srv/aideation',
    projectRoots: '/srv/projekte',
    platform: 'linux',
    credentials: {
      sshDir: '/home/du/.ssh',
      ghConfigDir: '/home/du/.config/gh',
      gitConfig: '/home/du/.gitconfig',
      githubTokenFile: '/home/du/.config/aideation/github-token',
    },
  });
  const worker = block(yaml, 'worker');
  for (const target of Object.values(CREDENTIAL_TARGETS))
    assert.match(worker, new RegExp(`target: "${target}"\\n {8}read_only: true`), target);
  const watchdog = block(yaml, 'watchdog');
  assert.doesNotMatch(watchdog, /\.ssh|gitconfig|config\/gh|github/);
  assert.equal(watchdog.match(/read_only: true/g)?.length, 2, 'Ordner und node_modules nur lesend');
  assert.doesNotMatch(yaml, /docker\.sock/);
  // Nur Worker und Wächter: Agent-Container entstehen per docker run und sehen diese Datei nie.
  assert.deepEqual(
    [...yaml.matchAll(/^ {2}(\S+):$/gm)].map((match) => match[1]),
    ['worker', 'watchdog'],
  );
  assert.doesNotMatch(workerOverride({ installDir: '/srv/a', platform: 'linux' }), /\.ssh|github_token/);
});

test('Worker-Compose: Git-Zugänge aus der .env oder dem Home, nur wenn vorhanden', () => {
  const present = new Set(['/home/du/.ssh', '/eigen/gh']);
  const found = detectCredentials(new Map([['DEV_LOG_WORKER_GH_CONFIG_DIR', '/eigen/gh']]), '/home/du', (path) =>
    present.has(path),
  );
  assert.deepEqual(found, {
    sshDir: '/home/du/.ssh',
    ghConfigDir: '/eigen/gh',
    gitConfig: null,
    githubTokenFile: null,
  });
});

test('Worker-Compose: schreibt nur eigene Dateien neu, eine von Hand angelegte bleibt', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aideation-override-'));
  try {
    await writeFile(join(dir, '.env'), 'DEV_LOG_PROJECT_ROOTS=/srv/projekte\n');
    const home = join(dir, 'home');
    assert.equal(await writeWorkerOverride(dir, { home, platform: 'linux' }), 'written');
    assert.match(await readFile(join(dir, OVERRIDE_FILE), 'utf8'), /DEV_LOG_PROJECT_ROOTS: "\/srv\/projekte"/);
    assert.equal(await writeWorkerOverride(dir, { home, platform: 'linux' }), 'unchanged');
    await writeFile(join(dir, OVERRIDE_FILE), 'services: {}\n');
    assert.equal(await writeWorkerOverride(dir, { home, platform: 'linux' }), 'kept');
    assert.equal(await readFile(join(dir, OVERRIDE_FILE), 'utf8'), 'services: {}\n');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
