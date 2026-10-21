import { decryptSecret } from '../core/secrets.js';
import { logged } from '../core/log.js';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { type CommandExecutor, runCommand } from '../core/command.js';
import { DEVELOPMENT_STATUS } from '../core/status.js';
import { sprintBranch } from './git-sync.js';

/**
 * Review-Container: projektübergreifend geteilte Docker-Container, die der Administrator freigibt (einer ist
 * Standard). Jeder zeigt einen Commit eines Projekts – gewählt in der Sprint-Ansicht oder automatisch für einen
 * Auftrag, der auf die Freigabe wartet – auf eigenem Port mit eigener Kopie der Projektdatenbank.
 */
export const REVIEW_IMAGE = 'aideation-review:latest';
const PORT_BASE = 4200;
/** Port im Container, auf dem der Review-Befehl die Oberfläche ausliefert. */
const INNER_PORT = 4200;

export const reviewPort = (slot: number): number => PORT_BASE + slot;
export const reviewContainer = (slot: number): string => `aideation_review_${slot}`;
export const reviewUrl = (slot: number): string => `http://localhost:${reviewPort(slot)}`;

export interface ReviewSlot {
  slot: number;
  enabled: boolean;
  projectSlug: string | null;
  commit: string | null;
  label: string | null;
  developmentId: string | null;
  kind: 'manual' | 'approval' | null;
  status: 'idle' | 'requested' | 'starting' | 'running' | 'failed' | 'stopping';
  startedAt: Date | null;
}

interface ProjectInfo {
  folder: string;
  command: string[];
  databaseUrl: string | null;
}

const SLOT_COLUMNS = `slot, enabled, project_slug AS "projectSlug", commit_sha AS commit, label,
  development_id AS "developmentId", kind, status, started_at AS "startedAt"`;

/** Projekt-Datenbank in eine eigene Kopie je Container: <db>_review_<n>, erreichbar aus Docker über host.docker.internal. */
export function reviewDatabase(databaseUrl: string, slot: number): { source: URL; target: URL } | null {
  try {
    const source = new URL(databaseUrl);
    const name = source.pathname.replace(/^\//, '');
    if (!/^[\w-]+$/.test(name)) return null;
    if (['localhost', '127.0.0.1', '::1', '[::1]'].includes(source.hostname)) source.hostname = 'host.docker.internal';
    const target = new URL(source.toString());
    target.pathname = `/${name}_review_${slot}`;
    return { source, target };
  } catch {
    return null;
  }
}

/**
 * Skript für die Datenbank-Kopie (im Postgres-Container unter `sh -c`). Erst in eine Datei dumpen, dann einspielen:
 * In einer Pipe zählte nur der Exit-Code von psql, ein gescheiterter pg_dump (Passwort, Host, Version) ergäbe still
 * eine leere Datenbank. ON_ERROR_STOP=1: auch SQL-Fehler beim Einspielen lassen die Kopie scheitern.
 */
export const DATABASE_COPY_SCRIPT = [
  'export PGHOST=$S_HOST PGPORT=$S_PORT PGUSER=$S_USER PGPASSWORD=$S_PASSWORD',
  'dropdb --if-exists --force "$T_DB"',
  'createdb "$T_DB"',
  'DUMP=$(mktemp)',
  'pg_dump --no-owner -f "$DUMP" "$S_DB"',
  'psql -q -v ON_ERROR_STOP=1 -d "$T_DB" -f "$DUMP" > /dev/null',
].join(' && ');

async function update(pool: Pool, slot: number, fields: Record<string, unknown>): Promise<void> {
  const keys = Object.keys(fields);
  await pool.query(
    `UPDATE review_slots SET ${keys.map((key, index) => `${key} = $${index + 2}`).join(', ')}, updated_at = NOW()
      WHERE slot = $1`,
    [slot, ...keys.map((key) => fields[key])],
  );
}

const CLEARED = {
  status: 'idle',
  project_slug: null,
  commit_sha: null,
  label: null,
  development_id: null,
  kind: null,
  message: null,
  started_at: null,
};

export class ReviewSlots {
  private imageReady = false;

  constructor(
    private readonly pool: Pool,
    private readonly installRoot: string,
    private readonly execute: CommandExecutor = runCommand,
    private readonly fetchUrl: (url: string) => Promise<boolean> = async (url) =>
      fetch(url, { signal: AbortSignal.timeout(3000) })
        .then((response) => response.status < 500)
        .catch(() => false),
  ) {}

  private docker(args: string[], timeoutMs = 60_000) {
    return this.execute(['docker', ...args], this.installRoot, { timeoutMs });
  }

  private async ensureImage(): Promise<string | null> {
    if (this.imageReady) return null;
    // Einmal je Worker-Start bauen (mit Cache schnell): so gilt immer der aktuelle Stand von deploy/review.
    const built = await this.docker(
      ['build', '-q', '-t', REVIEW_IMAGE, join(this.installRoot, 'deploy', 'review')],
      10 * 60_000,
    );
    if (built.exitCode !== 0) return `Review-Image nicht gebaut: ${built.output.slice(-300)}`;
    this.imageReady = true;
    return null;
  }

  private async project(slug: string): Promise<ProjectInfo | null> {
    const row = (
      await this.pool.query<{ folder: string; command: unknown; databaseUrl: string | null }>(
        `SELECT repository AS folder, review_command AS command, database_url AS "databaseUrl" FROM projects WHERE slug = $1`,
        [slug],
      )
    ).rows[0];
    if (!row) return null;
    const command =
      Array.isArray(row.command) && row.command.every((part) => typeof part === 'string')
        ? (row.command as string[])
        : [];
    let databaseUrl: string | null = null;
    try {
      databaseUrl = row.databaseUrl ? decryptSecret(row.databaseUrl) : null;
    } catch (error) {
      logged(`database-url:${slug}`)(error);
    }
    return { folder: row.folder, command, databaseUrl };
  }

  /** Wartende Aufträge (Review-Freigabe) bekommen automatisch einen freien Container. */
  private async assignApprovals(slots: ReviewSlot[]): Promise<void> {
    const shown = new Set(slots.map((slot) => slot.developmentId).filter(Boolean));
    const free = slots.filter((slot) => slot.enabled && slot.status === 'idle');
    if (!free.length) return;
    const waiting = (
      await this.pool.query<{ id: string; projectSlug: string; title: string }>(
        `SELECT id, project_slug AS "projectSlug", title FROM development_items
          WHERE status = '${DEVELOPMENT_STATUS.approval}' AND review_branch IS NOT NULL AND review_approved_at IS NULL
          ORDER BY review_since NULLS LAST`,
      )
    ).rows.filter((item) => !shown.has(item.id));
    for (const [index, item] of waiting.slice(0, free.length).entries()) {
      const slot = free[index]!;
      await update(this.pool, slot.slot, {
        status: 'requested',
        project_slug: item.projectSlug,
        development_id: item.id,
        kind: 'approval',
        label: `Freigabe: ${item.title}`.slice(0, 200),
        commit_sha: null,
        message: 'Auftrag wartet auf Freigabe – Container wird gestartet.',
        requested_at: new Date(),
      });
      slot.status = 'requested';
    }
  }

  async sync(): Promise<void> {
    let slots = (await this.pool.query<ReviewSlot>(`SELECT ${SLOT_COLUMNS} FROM review_slots ORDER BY slot`)).rows;
    await this.assignApprovals(slots);
    slots = (await this.pool.query<ReviewSlot>(`SELECT ${SLOT_COLUMNS} FROM review_slots ORDER BY slot`)).rows;
    for (const slot of slots) {
      try {
        await this.syncSlot(slot);
      } catch (error) {
        await update(this.pool, slot.slot, {
          status: 'failed',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private async approvalCommit(slot: ReviewSlot, folder: string): Promise<string | null> {
    const item = (
      await this.pool.query<{ status: string; branch: string | null; approved: boolean }>(
        `SELECT status, review_branch AS branch, review_approved_at IS NOT NULL AS approved FROM development_items WHERE id = $1`,
        [slot.developmentId],
      )
    ).rows[0];
    if (!item || item.status !== DEVELOPMENT_STATUS.approval || item.approved || !item.branch) return null;
    const head = await this.execute(['git', 'rev-parse', '--verify', '--quiet', `refs/heads/${item.branch}`], folder);
    return head.exitCode === 0 ? head.output.trim() : null;
  }

  /**
   * Stand für die Abnahme eines Auftrags: Sprint-Branch, solange der Sprint läuft (dort steckt der Auftrag schon),
   * sonst main. Null, wenn keiner der Branches existiert.
   */
  async acceptanceCommit(developmentId: string, folder: string): Promise<string | null> {
    const sprint = (
      await this.pool.query<{ name: string }>(
        `SELECT s.name FROM development_items d JOIN sprints s ON s.id = d.sprint_id
          WHERE d.id = $1 AND s.status IN ('planned', 'active')`,
        [developmentId],
      )
    ).rows[0];
    for (const branch of [...(sprint ? [sprintBranch(sprint.name)] : []), 'main']) {
      const head = await this.execute(['git', 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], folder);
      if (head.exitCode === 0 && head.output.trim()) return head.output.trim();
    }
    return null;
  }

  private async syncSlot(slot: ReviewSlot): Promise<void> {
    const name = reviewContainer(slot.slot);
    if (!slot.enabled || slot.status === 'stopping') {
      if (slot.status !== 'idle') {
        await this.docker(['rm', '-f', name]);
        await update(this.pool, slot.slot, CLEARED);
      }
      return;
    }
    if (slot.status === 'idle') return;
    const project = slot.projectSlug ? await this.project(slot.projectSlug) : null;
    if (!project) {
      await this.docker(['rm', '-f', name]);
      await update(this.pool, slot.slot, CLEARED);
      return;
    }
    // Freigabe-Container: endet mit der Freigabe; nach einer Nachbesserung (neuer Commit) neu starten.
    if (slot.kind === 'approval') {
      const commit = await this.approvalCommit(slot, project.folder);
      if (!commit) {
        await this.docker(['rm', '-f', name]);
        await update(this.pool, slot.slot, CLEARED);
        return;
      }
      if (slot.status !== 'requested' && slot.commit !== commit) {
        await update(this.pool, slot.slot, { status: 'requested', requested_at: new Date() });
        slot.status = 'requested';
      }
      slot.commit = commit;
    }
    // Abnahme aus „Aktionen“: Stand erst jetzt bestimmen (der Server sieht das Repository nicht).
    if (slot.kind === 'manual' && !slot.commit && slot.developmentId && slot.status === 'requested') {
      slot.commit = await this.acceptanceCommit(slot.developmentId, project.folder);
    }
    if (slot.status === 'requested') {
      await this.start(slot, project);
      return;
    }
    if (slot.status === 'starting' || slot.status === 'running') {
      const state = await this.docker(['inspect', '-f', '{{.State.Running}}', name], 15_000);
      if (state.output.trim() !== 'true') {
        const logs = await this.docker(['logs', '--tail', '12', name], 15_000);
        await update(this.pool, slot.slot, {
          status: 'failed',
          message: `Container beendet.\n${logs.output.trim().slice(-800)}`,
        });
        return;
      }
      if (slot.status === 'starting' && (await this.fetchUrl(reviewUrl(slot.slot)))) {
        await update(this.pool, slot.slot, { status: 'running', message: null });
      }
    }
  }

  private async start(slot: ReviewSlot, project: ProjectInfo): Promise<void> {
    const name = reviewContainer(slot.slot);
    if (!project.command.length) {
      await update(this.pool, slot.slot, {
        status: 'failed',
        message: 'Für dieses Projekt ist kein Review-Befehl eingestellt (Einstellungen → Review).',
      });
      return;
    }
    if (!slot.commit) {
      await update(this.pool, slot.slot, { status: 'failed', message: 'Kein Commit gewählt.' });
      return;
    }
    const imageProblem = await this.ensureImage();
    if (imageProblem) {
      await update(this.pool, slot.slot, { status: 'failed', message: imageProblem });
      return;
    }
    await update(this.pool, slot.slot, {
      status: 'starting',
      commit_sha: slot.commit,
      message: 'Container wird vorbereitet …',
    });
    await this.docker(['rm', '-f', name]);
    const env: string[] = [
      `REVIEW_COMMIT=${slot.commit}`,
      `REVIEW_COMMAND=${project.command.join(' ')}`,
      `REVIEW_LABEL=${slot.label ?? ''}`,
      `REVIEW_PUBLIC_URL=${reviewUrl(slot.slot)}`,
      `REVIEW_FRONTEND_PORT=${INNER_PORT}`,
      'REVIEW_BACKEND_PORT=3000',
      'REVIEW_HOST=0.0.0.0',
      'REVIEW_TLS=off',
      'DEV_LOG_REVIEW=1',
      'DEV_LOG_REVIEW_CONTAINER=1',
      'DEV_LOG_REVIEW_MAIN=/source',
    ];
    const database = project.databaseUrl ? reviewDatabase(project.databaseUrl, slot.slot) : null;
    if (database) {
      const copied = await this.copyDatabase(database.source, database.target);
      if (copied) {
        await update(this.pool, slot.slot, { status: 'failed', message: copied });
        return;
      }
      env.push(`DATABASE_URL=${database.target.toString()}`, 'DEV_LOG_REVIEW_DATABASE_READY=1');
    }
    const run = await this.docker([
      'run',
      '-d',
      '--name',
      name,
      '--label',
      `aideation.review=${slot.slot}`,
      '-p',
      `127.0.0.1:${reviewPort(slot.slot)}:${INNER_PORT}`,
      '--add-host',
      'host.docker.internal:host-gateway',
      '-v',
      `${project.folder}:/source:ro`,
      '-v',
      // Container läuft als node (deploy/review/Dockerfile); eigenes Volume, das alte gehört root.
      'aideation_review_npm_node:/home/node/.npm',
      ...env.flatMap((entry) => ['-e', entry]),
      REVIEW_IMAGE,
    ]);
    await update(
      this.pool,
      slot.slot,
      run.exitCode === 0
        ? { status: 'starting', started_at: new Date(), message: 'Installiert Abhängigkeiten und startet …' }
        : { status: 'failed', message: `docker run fehlgeschlagen: ${run.output.slice(-400)}` },
    );
  }

  /** Kopie der Projektdatenbank (pg_dump | psql) in einem kurzlebigen Postgres-Container. */
  private async copyDatabase(source: URL, target: URL): Promise<string | null> {
    const env = (url: URL, prefix: string) => [
      `${prefix}HOST=${url.hostname}`,
      `${prefix}PORT=${url.port || '5432'}`,
      `${prefix}USER=${decodeURIComponent(url.username)}`,
      `${prefix}PASSWORD=${decodeURIComponent(url.password)}`,
      `${prefix}DB=${url.pathname.slice(1)}`,
    ];
    const result = await this.docker(
      [
        'run',
        '--rm',
        '--add-host',
        'host.docker.internal:host-gateway',
        ...[...env(source, 'S_'), ...env(target, 'T_')].flatMap((entry) => ['-e', entry]),
        'postgres:17-alpine',
        'sh',
        '-c',
        DATABASE_COPY_SCRIPT,
      ],
      5 * 60_000,
    );
    return result.exitCode === 0 ? null : `Datenbank-Kopie fehlgeschlagen: ${result.output.slice(-400)}`;
  }
}
