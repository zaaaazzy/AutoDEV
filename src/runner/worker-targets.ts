import { existsSync, statSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { logged } from '../core/log.js';
import { treeLockName } from '../core/project-lock.js';
import { missingFolderMessage, volumeOf } from '../core/folder-guard.js';
import { projectFolderError } from '../core/validation.js';
import { sendPush } from '../core/push.js';
import { touchHealthFile, workerPath } from '../core/worker-container.js';
import { resolveAgentWorkspace } from './agent-workspace.js';
import { runWorkflow, type RunnerOptions } from './runner.js';
import { beatWorker, WORKER_BEAT_MS } from './worker-identity.js';

/** Ordner, aus dem dieser Worker läuft (die AIdeation-Installation). */
export const INSTALL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Ein Projekt aus Sicht des Workers: Laufoptionen samt Arbeitsordner oder der Grund, warum es nicht bedient wird. */
export interface Target {
  options: RunnerOptions;
  problem: string | null;
  /** Projektordner laut Projekt (für die Ausfall-Überwachung). */
  repository: string;
  /** Ordner fehlt nur vorübergehend (externes Laufwerk getrennt): Anfragen warten statt abgelehnt zu werden. */
  transient: boolean;
}

/** Mit --all wird jedes registrierte Projekt aus seinem eigenen Projektordner (projects.repository) bedient. */
export async function resolveTargets(pool: Pool, options: RunnerOptions): Promise<Target[]> {
  if (!options.all) {
    return [{ options, problem: null, repository: options.cwd, transient: false }];
  }
  const projects = await pool.query<{ slug: string; repository: string; separate: boolean }>(
    'SELECT slug, repository, agent_workspace AS separate FROM projects ORDER BY slug',
  );
  return Promise.all(
    projects.rows.map(async ({ slug, repository: stored, separate }) => {
      // Worker im Container: unter Windows eingetragene Pfade liegen dort im Format von Docker Desktop (/c/…).
      const repository = workerPath(stored);
      const outside = isAbsolute(repository) ? projectFolderError(repository) : null;
      const folder =
        !outside && isAbsolute(repository) && existsSync(repository) && statSync(repository).isDirectory()
          ? repository
          : null;
      // Der AIdeation-Ordner selbst (oder ein Projekt mit eigenem Arbeitsordner): Agents arbeiten in einem eigenen
      // Worktree, nie im Arbeitsordner der Menschen bzw. des laufenden Entwicklungsservers.
      const workspace = folder ? await resolveAgentWorkspace(folder, INSTALL_ROOT, undefined, separate) : null;
      const transient = !outside && !folder && isAbsolute(repository) && volumeOf(repository) !== null;
      return {
        options: { ...options, project: slug, cwd: workspace?.cwd ?? folder ?? options.cwd },
        problem: outside
          ? `Projekt ausserhalb des Projektbereichs – Agents bleiben gestoppt: ${outside}`
          : transient
            ? missingFolderMessage(repository)
            : !folder
              ? `Projektordner nicht gefunden: ${repository} (im AIdeation unter „Projekt“ den absoluten Pfad angeben)`
              : (workspace?.problem ?? null),
        repository,
        transient,
      };
    }),
  );
}

/** Projekte, die der Worker gerade bedienen kann (Ordner da, im Projektbereich). */
export function servedTargets(targets: readonly Target[]): Target[] {
  return targets.filter((target) => !target.problem);
}

/**
 * Läuft schon ein Auftrag eines anderen Projekts im selben echten Ordner (gleiches Repository, gemeinsamer
 * Agent-Worktree, Symlink)? Dann startet dieses Projekt nicht, statt unbemerkt auf die Ordner-Sperre zu warten.
 * Liefert das Projekt, das den Ordner gerade benutzt. Schlüssel immer über den realpath (`treeLockName`).
 */
export function folderInUseBy(cwd: string, running: ReadonlyMap<string, string>): string | null {
  const key = treeLockName(cwd);
  for (const [slug, other] of running) if (other === key) return slug;
  return null;
}

/** Ein Arbeitszyklus für ein Projekt; liefert true, wenn ein Auftrag darin gescheitert ist. */
export async function runProjectOnce(pool: Pool, options: RunnerOptions): Promise<boolean> {
  const results = await runWorkflow(pool, options);
  for (const { itemId, result } of results) {
    console.info(`${itemId}: ${result}`);
  }
  return results.some(({ result }) => result === 'failed');
}

/**
 * Lebenszeichen dieses Workers für die anderen Worker (runner_workers). Im Container (Dienst worker) erneuert jedes
 * gelungene Lebenszeichen zugleich die Datei des Healthchecks.
 */
export function workerBeat(pool: Pool, workerId: string): { start: () => Promise<void>; stop: () => void } {
  let timer: NodeJS.Timeout | undefined;
  const once = (): Promise<void> =>
    beatWorker(pool, workerId)
      .then(() => touchHealthFile())
      .catch(logged('worker-targets'));
  return {
    start: async () => {
      await once();
      timer = setInterval(() => void once(), WORKER_BEAT_MS);
      timer.unref();
    },
    stop: () => clearInterval(timer),
  };
}

const FOLDER_NOTICE_KEY = 'folder_outage_notified';
const FOLDER_NOTICE_PAUSE_MS = 10 * 60_000;
/** Zuletzt gemeldeter Ausfall je Laufwerk: ein wackelndes Kabel soll nicht jede Minute einen Push auslösen. */
const folderNotices = new Map<string, number>();

/** Push an die betroffenen Projekte, wenn ein Laufwerk wegfällt oder wiederkommt (je Laufwerk und Zustand einmal). */
export async function notifyFolders(pool: Pool, targets: Target[], volume: string, back: boolean): Promise<void> {
  const last = folderNotices.get(volume);
  if (!back && last && Date.now() - last < FOLDER_NOTICE_PAUSE_MS) return;
  if (back && !last) return;
  if (back) folderNotices.delete(volume);
  else folderNotices.set(volume, Date.now());
  const name = volume.startsWith('/Volumes/') ? `Laufwerk „${volume.slice('/Volumes/'.length)}“` : volume;
  for (const target of targets.filter((entry) => entry.repository.startsWith(volume))) {
    await sendPush(
      pool,
      {
        title: back ? `✅ ${name} wieder verbunden` : `⚠️ ${name} getrennt`,
        body: back
          ? 'Die Agents arbeiten weiter; unterbrochene Aufträge und wartende Anfragen laufen erneut.'
          : 'Die Agents pausieren, bis der Projektordner wieder erreichbar ist. Kabel und Stromversorgung prüfen.',
        url: `#dashboard?project=${encodeURIComponent(target.options.project)}`,
        tag: `${FOLDER_NOTICE_KEY}-${volume}`,
      },
      { project: target.options.project },
    ).catch(logged('worker-targets'));
  }
}
