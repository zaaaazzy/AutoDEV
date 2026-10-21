import type { Router } from 'express';
import type { Pool } from 'pg';
import { access } from './access.js';
import { isRecord } from '../core/validation.js';
import { JOB_KINDS } from '../runner/scheduler.js';
import { hasRole, type Principal } from './roles.js';

/**
 * Wartungs-Jobs des Workers lesen und einstellen (Aktiv, Intervall, Startzeit, Konfiguration) – nur für
 * Administratoren, auch beim Lesen. Die Job-Art bleibt fest; der Worker liest die Werte in jedem Zyklus neu.
 */
const JOB_SELECT = `key, enabled, start_at AS "startAt", interval_seconds AS "intervalSeconds", job_kind AS "kind",
  config, next_run_at AS "nextRunAt", last_run_at AS "lastRunAt", last_status AS "lastStatus",
  last_message AS "lastMessage", updated_at AS "updatedAt"`;

export const MIN_INTERVAL_SECONDS = 60;
export const MAX_INTERVAL_SECONDS = 30 * 24 * 3600;
const MAX_CONFIG_LENGTH = 4000;
const JOB_KEY = /^[a-z0-9_-]{1,64}$/;

export interface JobUpdate {
  enabled: boolean | null;
  intervalSeconds: number | null;
  startAt: string | null;
  config: string | null;
}

/** Prüft den PATCH-Körper; liefert die Änderung oder eine Fehlermeldung. */
export function parseJobUpdate(body: unknown): JobUpdate | string {
  if (!isRecord(body)) return 'Ungültige Angaben.';
  const update: JobUpdate = { enabled: null, intervalSeconds: null, startAt: null, config: null };
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') return '„enabled“ muss wahr oder falsch sein.';
    update.enabled = body.enabled;
  }
  if (body.intervalSeconds !== undefined) {
    const value = body.intervalSeconds;
    if (
      typeof value !== 'number' ||
      !Number.isInteger(value) ||
      value < MIN_INTERVAL_SECONDS ||
      value > MAX_INTERVAL_SECONDS
    ) {
      return `Intervall in Sekunden zwischen ${MIN_INTERVAL_SECONDS} und ${MAX_INTERVAL_SECONDS} angeben.`;
    }
    update.intervalSeconds = value;
  }
  if (body.startAt !== undefined) {
    const date = typeof body.startAt === 'string' ? new Date(body.startAt) : null;
    if (!date || Number.isNaN(date.getTime())) return 'Startzeit als Datum mit Uhrzeit (ISO 8601) angeben.';
    update.startAt = date.toISOString();
  }
  if (body.config !== undefined) {
    if (!isRecord(body.config)) return 'Konfiguration muss ein JSON-Objekt sein.';
    const text = JSON.stringify(body.config);
    if (text.length > MAX_CONFIG_LENGTH) return `Konfiguration höchstens ${MAX_CONFIG_LENGTH} Zeichen.`;
    update.config = text;
  }
  if (Object.values(update).every((value) => value === null)) return 'Keine Änderung angegeben.';
  return update;
}

export function registerScheduledJobRoutes(app: Router, pool: Pool): void {
  /** Zusätzliche Rollenprüfung in der Route (Lesen prüft der Rollenwächter nicht, nur den Mandanten). */
  const admin = (locals: Record<string, unknown>): boolean =>
    hasRole(locals.principal as Principal | undefined, 'admin');

  app.get('/scheduled-jobs', access({ tenant: 'admin' }), async (_request, response, next) => {
    try {
      if (!admin(response.locals)) return void response.status(403).json({ message: 'Nur für Administratoren.' });
      const jobs = (await pool.query(`SELECT ${JOB_SELECT} FROM scheduled_jobs ORDER BY key`)).rows;
      response.json({ jobs, kinds: Object.keys(JOB_KINDS) });
    } catch (error) {
      next(error);
    }
  });

  app.patch('/scheduled-jobs/:key', access({ role: 'admin', tenant: 'admin' }), async (request, response, next) => {
    try {
      if (!admin(response.locals)) return void response.status(403).json({ message: 'Nur für Administratoren.' });
      const key = request.params.key ?? '';
      if (!JOB_KEY.test(key)) return void response.status(404).json({ message: 'Job nicht gefunden.' });
      const update = parseJobUpdate(request.body);
      if (typeof update === 'string') return void response.status(400).json({ message: update });
      // Neues Intervall oder neue Startzeit: nächster Lauf ab dem letzten Lauf neu takten (nicht vor der Startzeit).
      const result = await pool.query(
        `UPDATE scheduled_jobs SET
            enabled = COALESCE($2::boolean, enabled),
            interval_seconds = COALESCE($3::integer, interval_seconds),
            start_at = COALESCE($4::timestamptz, start_at),
            config = COALESCE($5::jsonb, config),
            next_run_at = CASE WHEN $3::integer IS NULL AND $4::timestamptz IS NULL THEN next_run_at
              ELSE GREATEST(COALESCE($4::timestamptz, start_at),
                COALESCE(last_run_at + make_interval(secs => COALESCE($3::integer, interval_seconds)),
                         COALESCE($4::timestamptz, start_at))) END,
            updated_at = NOW()
          WHERE key = $1 RETURNING ${JOB_SELECT}`,
        [key, update.enabled, update.intervalSeconds, update.startAt, update.config],
      );
      if (!result.rows[0]) return void response.status(404).json({ message: 'Job nicht gefunden.' });
      response.json({ job: result.rows[0] });
    } catch (error) {
      next(error);
    }
  });
}
