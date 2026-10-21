import { execFileSync } from 'node:child_process';

const controller = new AbortController();
const children = new Set<number>();

export const shutdownSignal: AbortSignal = controller.signal;
export const isShuttingDown = (): boolean => controller.signal.aborted;

/**
 * Neustart angefordert oder Container im Bau: keine neue Arbeit mehr starten (Aufträge, Chat, Tests, Jobs), nur
 * Laufendes zu Ende bringen. Sonst würde der Neustart sie mitten im Schritt beenden.
 */
let draining = false;
export const isDraining = (): boolean => draining;
export function setDraining(value: boolean): void {
  draining = value;
}

export function trackChild(pid: number): () => void {
  children.add(pid);
  return () => children.delete(pid);
}

export function killGroup(pid: number): void {
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // Prozess existiert nicht mehr.
  }
}

/** Stoppt alle laufenden Agent-Prozesse (inklusive ihrer Kindprozesse) und bricht Modellanfragen ab. */
export function beginShutdown(): void {
  controller.abort();
  for (const pid of children) killGroup(pid);
}

/**
 * Beendet Prozesse eines abgestürzten Workers. Nur wenn der Prozess noch existiert, eine eigene Gruppe führt
 * und zur Startzeit des Schritts gestartet wurde, damit wiederverwendete PIDs nicht getroffen werden.
 */
export function killOrphan(pid: number, spawnedAt: Date): boolean {
  try {
    const started = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' }).trim();
    const startedMs = Date.parse(started);
    if (!started || Number.isNaN(startedMs) || Math.abs(startedMs - spawnedAt.getTime()) > 5_000) return false;
    killGroup(pid);
    return true;
  } catch {
    return false;
  }
}
