import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { groupAlive, killOrphan, processStartTime } from './shutdown.js';

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Startet eine eigene Prozessgruppe wie runCommand und liefert die PID des Gruppenführers. */
function startGroup(script: string): { pid: number; done: Promise<void> } {
  const child = spawn('sh', ['-c', script], { detached: true, stdio: 'ignore', env: { PATH: process.env.PATH } });
  const done = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  assert.ok(child.pid);
  return { pid: child.pid, done };
}

function cleanup(pid: number): void {
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // schon beendet
  }
}

test('Altprozess mit passender Startzeit: die ganze Gruppe wird beendet', async () => {
  const group = startGroup('sleep 30 & sleep 30');
  try {
    await pause(200);
    const started = processStartTime(group.pid);
    assert.ok(started);
    assert.equal(killOrphan(group.pid, started), 'killed');
    await group.done;
    await pause(100);
    assert.equal(groupAlive(group.pid), false);
  } finally {
    cleanup(group.pid);
  }
});

test('neu vergebene PID (andere Startzeit) wird nicht angefasst', async () => {
  const group = startGroup('sleep 30');
  try {
    await pause(200);
    assert.equal(killOrphan(group.pid, new Date(Date.now() - 3_600_000)), 'reused');
    assert.equal(groupAlive(group.pid), true, 'fremder Prozess lebt weiter');
  } finally {
    cleanup(group.pid);
  }
});

test('Gruppenführer schon weg, Kindprozess (z. B. Dev-Server) lebt noch: die Gruppe wird trotzdem beendet', async () => {
  // Der Führer startet einen Hintergrundprozess und endet sofort – wie ein abgestürzter Agent mit laufendem Server.
  const group = startGroup('sleep 30 >/dev/null 2>&1 &');
  try {
    await group.done;
    await pause(100);
    assert.equal(processStartTime(group.pid), null);
    assert.equal(groupAlive(group.pid), true, 'Hintergrundprozess hält die Gruppe am Leben');
    assert.equal(killOrphan(group.pid, new Date()), 'killed');
    assert.equal(groupAlive(group.pid), false);
  } finally {
    cleanup(group.pid);
  }
});

test('weder Prozess noch Gruppe vorhanden: nichts zu tun', async () => {
  const group = startGroup('exit 0');
  await group.done;
  await pause(100);
  assert.equal(killOrphan(group.pid, new Date()), 'gone');
});
