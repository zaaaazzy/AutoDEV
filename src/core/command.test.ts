import assert from 'node:assert/strict';
import test from 'node:test';
import { OUTPUT_GRACE_MS, runCommand } from './command.js';

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test('Zeitlimit beendet die ganze Prozessgruppe, auch Kindprozesse, die stdout offen halten', async () => {
  const startedAt = Date.now();
  // Ohne Gruppen-Kill lebten die beiden sleep weiter, hielten die Pipe offen, und runCommand käme erst nach 30 s zurück.
  const result = await runCommand(['sh', '-c', 'sleep 30 & echo "child $!"; sleep 30'], process.cwd(), {
    timeoutMs: 300,
  });
  assert.ok(Date.now() - startedAt < 5_000, `dauerte ${Date.now() - startedAt} ms`);
  assert.notEqual(result.exitCode, 0);
  assert.match(result.output, /Process ended by SIGKILL \(timeout or kill\)/);
  const child = Number(/child (\d+)/.exec(result.output)?.[1]);
  assert.ok(child > 0);
  assert.equal(alive(child), false, 'Hintergrundprozess wurde mit beendet');
});

test('ein Enkelprozess ausserhalb der Gruppe hält das Ergebnis nicht auf', async () => {
  // Der Enkel startet in eigener Gruppe (detached), erbt aber stdout und hält die Pipe offen.
  const script =
    "const c = require('node:child_process').spawn('sleep', ['30'], { detached: true, stdio: 'inherit' });" +
    "console.log('grandchild ' + c.pid); c.unref();";
  const startedAt = Date.now();
  const result = await runCommand([process.execPath, '-e', script], process.cwd());
  const grandchild = Number(/grandchild (\d+)/.exec(result.output)?.[1]);
  try {
    assert.equal(result.exitCode, 0);
    assert.ok(grandchild > 0);
    assert.ok(Date.now() - startedAt < OUTPUT_GRACE_MS + 3_000, `dauerte ${Date.now() - startedAt} ms`);
  } finally {
    if (grandchild > 0 && alive(grandchild)) process.kill(grandchild, 'SIGKILL');
  }
});

test('ein normaler Befehl liefert Ausgabe und Exit-Code wie bisher', async () => {
  const result = await runCommand(['sh', '-c', 'echo hallo; exit 3'], process.cwd(), { timeoutMs: 5_000 });
  assert.equal(result.exitCode, 3);
  assert.equal(result.output, 'hallo\n');
});
