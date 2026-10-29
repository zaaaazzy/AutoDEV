import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { inWorkerContainer, touchHealthFile, workerPath } from './worker-container.js';

const container = { DEV_LOG_WORKER_CONTAINER: '1' };

test('Worker-Container: Windows-Pfade aus der Datenbank im Format von Docker Desktop, sonst unverändert', () => {
  assert.equal(inWorkerContainer(container), true);
  assert.equal(inWorkerContainer({}), false);
  assert.equal(workerPath('C:\\Projekte\\app', container), '/c/Projekte/app');
  assert.equal(workerPath('d:/Code/spiel', container), '/d/Code/spiel');
  assert.equal(workerPath('/Volumes/Daten/app', container), '/Volumes/Daten/app');
  assert.equal(workerPath('C:\\Projekte\\app', {}), 'C:\\Projekte\\app', 'auf dem Host bleibt der Pfad');
});

test('Worker-Container: Lebenszeichen-Datei nur mit DEV_LOG_WORKER_HEALTH_FILE', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aideation-health-'));
  try {
    const file = join(dir, 'alive');
    await touchHealthFile({});
    await assert.rejects(readFile(file, 'utf8'));
    await touchHealthFile({ DEV_LOG_WORKER_HEALTH_FILE: file });
    assert.match(await readFile(file, 'utf8'), /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
