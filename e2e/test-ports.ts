import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Freier Port und eigene Testdatenbank je Lauf. Mehrere Läufe nebeneinander (Gate eines anderen Ordners, Tester-Agent,
 * Handlauf) belegten sonst denselben festen Port („…/health is already used“) und dieselbe Datenbank, die serve.ts
 * beim Start löscht. Ist der Wunschport frei, bleibt alles wie bisher; sonst wird in 100er-Schritten gesucht
 * (E2E 3195 → 3295 → 3395 …, Oberflächentest 3196 → 3296 …) und die Datenbank bekommt den Port als Endung.
 *
 * Ein Blick, ob der Port gerade frei ist, reicht nicht: Der Testserver bindet ihn erst Sekunden später, ein zweiter
 * Lauf sähe ihn bis dahin ebenfalls frei. Deshalb hält jeder Lauf bis zu seinem Ende eine Sperrdatei je Port
 * (PID und Zufallswert); die Sperre eines beendeten Prozesses gilt als verwaist und wird übernommen.
 * Das Ergebnis steht in der Umgebung, damit Playwright-Worker und Testserver denselben Wert sehen.
 */
const PROBE = `
const server = require('node:net').createServer();
server.once('error', () => console.log('busy'));
server.once('listening', () => server.close(() => console.log('free')));
server.listen(Number(process.argv[1]), '127.0.0.1');
`;
const ATTEMPTS = 20;

const lockDirectory = () => process.env.E2E_LOCK_DIR ?? tmpdir();
export const portLockFile = (port: number) => join(lockDirectory(), `dev-log-test-port-${port}.lock`);

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: Prozess gibt es, gehört nur einem anderen Benutzer.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/** Sperrt den Port für diesen Prozess; false, wenn ihn ein lebender Lauf hält. */
function lockPort(port: number, token: string): boolean {
  const file = portLockFile(port);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const handle = openSync(file, 'wx');
      writeSync(handle, `${process.pid} ${token}`);
      closeSync(handle);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let content: string;
      try {
        content = readFileSync(file, 'utf8');
      } catch {
        continue; // eben freigegeben
      }
      const pid = Number(content.split(' ')[0]);
      // Leere Datei: ein anderer Lauf schreibt gerade hinein – gilt als belegt.
      if (!content || (pid > 0 && isAlive(pid))) return false;
      try {
        if (readFileSync(file, 'utf8') === content) unlinkSync(file);
      } catch {
        // schon von einem anderen Lauf aufgeräumt
      }
    }
  }
  return false;
}

/** Gibt die Sperre frei, aber nur die eigene (Token), nie die eines anderen Laufs. */
function unlockPort(port: number, token: string): void {
  try {
    if (readFileSync(portLockFile(port), 'utf8') === `${process.pid} ${token}`) unlinkSync(portLockFile(port));
  } catch {
    // schon weg
  }
}

const isFree = (port: number) =>
  execFileSync(process.execPath, ['-e', PROBE, String(port)], { encoding: 'utf8' }).trim() === 'free';

export function reservePort(variable: string, preferred: number): number {
  const fixed = process.env[variable];
  if (fixed) return Number(fixed);
  const token = randomBytes(8).toString('hex');
  for (let index = 0; index < ATTEMPTS; index++) {
    const port = preferred + index * 100;
    if (!lockPort(port, token)) continue;
    // Belegt von etwas anderem als einem Testlauf (z. B. ein von Hand gestarteter Server): weitersuchen.
    if (!isFree(port)) {
      unlockPort(port, token);
      continue;
    }
    // Bis Prozessende halten: Playwright beendet sich auch bei Strg+C regulär; nach einem Absturz ist die PID tot.
    process.once('exit', () => unlockPort(port, token));
    process.env[variable] = String(port);
    return port;
  }
  throw new Error(
    `Kein freier Testport ab ${preferred} (${ATTEMPTS} Versuche in 100er-Schritten). Laufen so viele Testläufe gleichzeitig?`,
  );
}

/** Testdatenbank zum Port: der Standardname am Wunschport, sonst mit Port-Endung (z. B. dev_log_e2e_3295). */
export function reserveDatabase(variable: string, base: string, port: number, preferred: number): string {
  process.env[variable] ??= port === preferred ? base : `${base}_${port}`;
  return process.env[variable];
}
