import { writeFile } from 'node:fs/promises';
import { dockerHostPath } from './sandbox.js';

/**
 * Worker als Compose-Dienst (docker-compose.yml, Dienst worker): DEV_LOG_WORKER_CONTAINER=1. Der Container ist Linux,
 * die Projektordner sind mit dem Pfad des Hosts eingebunden – unter Windows im Format von Docker Desktop (/c/…).
 */
export function inWorkerContainer(environment: NodeJS.ProcessEnv = process.env): boolean {
  return environment.DEV_LOG_WORKER_CONTAINER?.trim() === '1';
}

/**
 * Projektpfad aus der Datenbank, wie ihn der Worker sieht. In der Oberfläche unter Windows eingetragene Pfade
 * (C:\Projekte\app) liegen im Worker-Container unter /c/Projekte/app; alles andere bleibt unverändert.
 */
export function workerPath(path: string, environment: NodeJS.ProcessEnv = process.env): string {
  if (!inWorkerContainer(environment) || !/^[A-Za-z]:[\\/]/.test(path)) return path;
  return dockerHostPath(path, 'win32');
}

/**
 * Lebenszeichen für den Healthcheck des Containers: Datei DEV_LOG_WORKER_HEALTH_FILE nach jedem erfolgreich
 * geschriebenen Lebenszeichen in der Datenbank erneuern. Ohne Variable (Worker auf dem Host) geschieht nichts.
 */
export async function touchHealthFile(environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  const file = environment.DEV_LOG_WORKER_HEALTH_FILE?.trim();
  if (file) await writeFile(file, `${new Date().toISOString()}\n`);
}
