import { execFileSync } from 'node:child_process';

const controller = new AbortController();
const children = new Set<number>();

export const shutdownSignal: AbortSignal = controller.signal;
export const isShuttingDown = (): boolean => controller.signal.aborted;

/** Ein gestarteter Prozess (Gruppenführer) mit Startzeit, damit eine später neu vergebene PID erkennbar bleibt. */
export interface TrackedProcess {
  pid: number;
  startedAt: Date;
  /** Programm und Arbeitsordner, nur zur Diagnose (keine Argumente: die enthalten Prompts). */
  command: string;
  cwd: string;
}

/** Dauerhafter Speicher der laufenden Prozesse, damit ein neu gestarteter Worker die Altprozesse findet. */
export interface ProcessStore {
  add(entry: TrackedProcess): void;
  remove(entry: TrackedProcess): void;
}

let store: ProcessStore | null = null;

/** Nur der Worker setzt einen Speicher; ohne ihn werden Prozesse nur im Speicher dieses Prozesses geführt. */
export function setProcessStore(next: ProcessStore | null): void {
  store = next;
}

export function trackChild(pid: number, details: { command?: string; cwd?: string } = {}): () => void {
  children.add(pid);
  const entry: TrackedProcess = { pid, startedAt: new Date(), command: details.command ?? '', cwd: details.cwd ?? '' };
  const target = store;
  target?.add(entry);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    children.delete(pid);
    target?.remove(entry);
  };
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

/**
 * Beendet die ganze Prozessgruppe. true, wenn das Signal zugestellt wurde. „Gibt es nicht mehr“ (ESRCH) ist kein
 * Fehler; alles andere (z. B. EPERM) wird gemeldet.
 */
export function killGroup(pid: number): boolean {
  try {
    process.kill(-pid, 'SIGKILL');
    return true;
  } catch (error) {
    if (errorCode(error) !== 'ESRCH') {
      console.warn(`Prozessgruppe ${pid} konnte nicht beendet werden: ${(error as Error).message}`);
    }
    return false;
  }
}

/** Lebt noch ein Prozess der Gruppe? EPERM heißt: es gibt ihn, er gehört aber nicht uns. */
export function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== 'ESRCH';
  }
}

/** Stoppt alle laufenden Agent-Prozesse (inklusive ihrer Kindprozesse) und bricht Modellanfragen ab. */
export function beginShutdown(): void {
  controller.abort();
  for (const pid of children) killGroup(pid);
}

/** Startzeit eines Prozesses laut ps, null wenn es ihn nicht gibt. */
export function processStartTime(pid: number): Date | null {
  try {
    const started = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const startedMs = Date.parse(started);
    return started && !Number.isNaN(startedMs) ? new Date(startedMs) : null;
  } catch (error) {
    // ps endet mit Status 1, wenn die PID nicht existiert; fehlt ps selbst, ist das ein echter Fehler.
    if (errorCode(error) === 'ENOENT') throw error;
    return null;
  }
}

/**
 * Ergebnis beim Aufräumen eines Altprozesses:
 * - killed: Gruppe beendet,
 * - gone: weder Prozess noch Gruppe existieren,
 * - reused: die PID gehört inzwischen einem anderen Prozess (nicht angefasst),
 * - failed: die Gruppe lebt nach dem Beenden noch oder ließ sich nicht prüfen.
 */
export type OrphanResult = 'killed' | 'gone' | 'reused' | 'failed';

const ORPHAN_WAIT_MS = 2_000;

/** Lebende Mitglieder der Gruppe laut ps; Zombies zählen nicht, sie laufen nicht mehr und warten nur aufs Abholen. */
function liveMembers(pgid: number): number {
  const lines = execFileSync('ps', ['-A', '-o', 'pgid=,stat='], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).split('\n');
  return lines.filter((line) => {
    const [group, state] = line.trim().split(/\s+/);
    return Number(group) === pgid && !state?.startsWith('Z');
  }).length;
}

function waitUntilGone(pid: number): boolean {
  const deadline = Date.now() + ORPHAN_WAIT_MS;
  while (groupAlive(pid) && liveMembers(pid) > 0) {
    if (Date.now() > deadline) return false;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  return true;
}

/**
 * Beendet Prozesse eines abgestürzten Workers. Lebt der Gruppenführer noch, muss seine Startzeit zum gespeicherten
 * Start passen, sonst ist die PID neu vergeben. Ist der Führer schon weg, kann eine Gruppe mit dieser Nummer nur
 * noch die alte sein: solange eine Gruppe existiert, vergibt das System ihre Nummer nicht neu.
 */
export function killOrphan(pid: number, spawnedAt: Date): OrphanResult {
  let started: Date | null;
  try {
    started = processStartTime(pid);
  } catch (error) {
    console.warn(`Altprozess ${pid} konnte nicht geprüft werden: ${(error as Error).message}`);
    return 'failed';
  }
  if (started) {
    if (Math.abs(started.getTime() - spawnedAt.getTime()) > 5_000) return 'reused';
  } else if (!groupAlive(pid)) {
    return 'gone';
  }
  killGroup(pid);
  try {
    return waitUntilGone(pid) ? 'killed' : 'failed';
  } catch (error) {
    console.warn(`Altprozess ${pid} konnte nicht geprüft werden: ${(error as Error).message}`);
    return 'failed';
  }
}
