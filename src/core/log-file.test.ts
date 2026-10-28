import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { followLogFile } from './log-file.js';

const stream = () => ({ write: (() => false) as NodeJS.WriteStream['write'] });

test('Worker-Log: nach der Rotation (umbenannt) geht das Log unter dem bekannten Pfad weiter, nichts geht verloren', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aideation-log-'));
  const path = join(dir, 'aideation-worker.log');
  const out = stream();
  const err = stream();
  const log = followLogFile(path, [out, err], 60_000);
  try {
    out.write('vorher\n');
    err.write(Buffer.from('fehler\n'));
    assert.equal(statSync(path).mode & 0o777, 0o600);
    // newsyslog benennt um (und legt eine neue Datei an, hier fehlt sie zunächst ganz).
    renameSync(path, `${path}.0`);
    out.write('dazwischen\n');
    log.check();
    out.write('nachher\n', 'utf8', () => undefined);
    assert.equal(readFileSync(`${path}.0`, 'utf8'), 'vorher\nfehler\ndazwischen\n');
    assert.equal(readFileSync(path, 'utf8'), 'nachher\n');
    // Ohne Rotation bleibt die Datei dieselbe.
    log.check();
    out.write('weiter\n');
    assert.equal(readFileSync(path, 'utf8'), 'nachher\nweiter\n');
  } finally {
    log.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Worker-Log: stop() gibt die ursprünglichen write-Funktionen zurück', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aideation-log-'));
  const out = stream();
  const original = out.write;
  followLogFile(join(dir, 'x.log'), [out], 60_000).stop();
  assert.equal(out.write, original);
  rmSync(dir, { recursive: true, force: true });
});
