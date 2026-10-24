import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { portLockFile, reserveDatabase, reservePort } from '../e2e/test-ports.js';

// Eigener Sperrordner und zufälliger Wunschport je Test: kein Zusammenstoss mit echten Läufen auf 3195/3196.
const LOCKS = mkdtempSync(join(tmpdir(), 'dev-log-test-ports-'));
process.env.E2E_LOCK_DIR = LOCKS;
test.after(() => rmSync(LOCKS, { recursive: true, force: true }));
let next = 0;
const preferredPort = () => 41_000 + Math.floor(Math.random() * 40) * 10 + next++;
const variable = () => `TEST_PORT_${randomName()}`;
const randomName = () => Math.random().toString(36).slice(2, 10).toUpperCase();

test('zwei Läufe nacheinander gestartet, bevor der erste seinen Server bindet: eigener Port und eigene Datenbank', () => {
  const preferred = preferredPort();
  // Der Port ist nach der Reservierung des ersten Laufs noch frei (Server startet erst später) – trotzdem kein Doppel.
  const first = reservePort(variable(), preferred);
  const second = reservePort(variable(), preferred);
  assert.equal(first, preferred);
  assert.equal(second, preferred + 100);
  const firstDatabase = reserveDatabase(variable(), 'dev_log_e2e', first, preferred);
  const secondDatabase = reserveDatabase(variable(), 'dev_log_e2e', second, preferred);
  assert.equal(firstDatabase, 'dev_log_e2e');
  assert.equal(secondDatabase, `dev_log_e2e_${preferred + 100}`);
});

test('fester Wert aus der Umgebung (Playwright-Worker, Testserver) wird übernommen, ohne neu zu sperren', () => {
  const name = variable();
  process.env[name] = '45678';
  assert.equal(reservePort(name, preferredPort()), 45678);
  assert.equal(existsSync(portLockFile(45678)), false);
});

test('Port eines anderen Programms wird übersprungen und die Sperre dafür wieder freigegeben', async () => {
  const preferred = preferredPort();
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(preferred, '127.0.0.1', resolve));
  try {
    assert.equal(reservePort(variable(), preferred), preferred + 100);
    assert.equal(existsSync(portLockFile(preferred)), false);
  } finally {
    server.close();
  }
});

test('Sperre eines beendeten Laufs gilt als verwaist, die eines lebenden nicht', () => {
  const dead = spawnSync(process.execPath, ['-e', '']).pid!;
  const stale = preferredPort();
  writeFileSync(portLockFile(stale), `${dead} abc`);
  assert.equal(reservePort(variable(), stale), stale);

  const held = preferredPort();
  writeFileSync(portLockFile(held), `${process.ppid} abc`);
  assert.equal(reservePort(variable(), held), held + 100);
});

test('ein beendeter Lauf gibt seine Sperre frei, nicht aber die eines anderen', () => {
  const preferred = preferredPort();
  const module = new URL('../e2e/test-ports.ts', import.meta.url).href;
  const output = execFileSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      `import { reservePort } from '${module}'; console.log(reservePort('E2E_PORT', ${preferred}));`,
    ],
    { encoding: 'utf8', env: { ...process.env, E2E_PORT: '', E2E_LOCK_DIR: LOCKS } },
  );
  assert.equal(Number(output.trim()), preferred);
  assert.equal(existsSync(portLockFile(preferred)), false);
  // Die Sperren dieses Prozesses bleiben bestehen, solange er läuft.
  const mine = reservePort(variable(), preferredPort());
  assert.equal(existsSync(portLockFile(mine)), true);
});

test('Konfigurationen und serve.ts beziehen Port und Datenbank aus test-ports.ts', async () => {
  const { readFile } = await import('node:fs/promises');
  for (const config of ['playwright.config.ts', 'full.config.ts', 'styles.config.ts']) {
    const source = await readFile(new URL(`../e2e/${config}`, import.meta.url), 'utf8');
    assert.match(source, /reservePort\(/, config);
    assert.match(source, /reserveDatabase\(/, config);
    assert.doesNotMatch(source, /127\.0\.0\.1:31\d\d/, `${config}: kein fester Port`);
  }
  const serve = await readFile(new URL('../e2e/serve.ts', import.meta.url), 'utf8');
  assert.match(serve, /process\.env\.E2E_DATABASE/);
});
