import { execFileSync } from 'node:child_process';

/**
 * Freier Port und eigene Testdatenbank je Lauf. Mehrere Läufe nebeneinander (Gate eines anderen Ordners, Tester-Agent,
 * Handlauf) belegten sonst denselben festen Port („…/health is already used“) und dieselbe Datenbank, die serve.ts
 * beim Start löscht. Ist der Wunschport frei, bleibt alles wie bisher; sonst wird in 100er-Schritten gesucht
 * (E2E 3195 → 3295 → 3395 …, Oberflächentest 3196 → 3296 …) und die Datenbank bekommt den Port als Endung.
 * Das Ergebnis steht in der Umgebung, damit Playwright-Worker und Testserver denselben Wert sehen.
 */
const PROBE = `
const net = require('node:net');
const preferred = Number(process.argv[1]);
const tryPort = (port, left) => {
  const server = net.createServer();
  server.once('error', () => (left > 0 ? tryPort(port + 100, left - 1) : console.log(0)));
  server.once('listening', () => server.close(() => console.log(port)));
  server.listen(port, '127.0.0.1');
};
tryPort(preferred, 20);
`;

export function reservePort(variable: string, preferred: number): number {
  const fixed = process.env[variable];
  if (fixed) return Number(fixed);
  const found = Number(execFileSync(process.execPath, ['-e', PROBE, String(preferred)], { encoding: 'utf8' }).trim());
  const port = found > 0 ? found : preferred;
  process.env[variable] = String(port);
  return port;
}

/** Testdatenbank zum Port: der Standardname am Wunschport, sonst mit Port-Endung (z. B. dev_log_e2e_3295). */
export function reserveDatabase(variable: string, base: string, port: number, preferred: number): string {
  process.env[variable] ??= port === preferred ? base : `${base}_${port}`;
  return process.env[variable];
}
