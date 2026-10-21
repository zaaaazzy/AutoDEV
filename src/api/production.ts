import type { Router } from 'express';
import type { Pool } from 'pg';
import { access } from './access.js';
import { isUuid, parseProjectSlug } from '../core/validation.js';
import { createIngestToken } from './ingest.js';
import { browserSnippet, ingestEndpoint, nodeSnippet, publicBaseUrl } from './production-snippets.js';

const HISTORY_HOURS = 48;

/** Stunden-Verlauf lückenlos (fehlende Stunden = 0), älteste zuerst. */
export function fillHistory(
  rows: { hour: Date | string; count: number }[],
  now = new Date(),
  hours = HISTORY_HOURS,
): { hour: string; count: number }[] {
  const byHour = new Map(rows.map((row) => [new Date(row.hour).getTime(), Number(row.count)]));
  const current = new Date(now);
  current.setUTCMinutes(0, 0, 0);
  return Array.from({ length: hours }, (_, index) => {
    const hour = current.getTime() - (hours - 1 - index) * 3600_000;
    return { hour: new Date(hour).toISOString(), count: byHour.get(hour) ?? 0 };
  });
}

/** Oberfläche des Produktions-Rückkanals: Status fürs Dashboard, Ereignisse eines Bugs, Ingest-Token. */
export function registerProductionRoutes(app: Router, pool: Pool): void {
  app.get('/projects/:slug/production', access({ tenant: 'project' }), async (request, response, next) => {
    try {
      const slug = parseProjectSlug(request.params.slug ?? '');
      if (!slug) return void response.status(400).json({ message: 'Ungültiges Projekt.' });
      const row = (
        await pool.query(
          `SELECT p.health_url AS "healthUrl", cardinality(p.log_services) > 0 AS "logsConfigured",
                  p.ingest_token_hash IS NOT NULL AS "ingestConfigured",
                  COALESCE(s.down, FALSE) AS down, COALESCE(s.failures, 0) AS failures, s.last_error AS "lastError",
                  s.checked_at AS "checkedAt", s.down_since AS "downSince", s.logs_scanned_at AS "logsScannedAt",
                  s.log_error AS "logError",
                  (SELECT COUNT(*)::int FROM bugs b WHERE b.project_slug = p.slug AND b.source = 'production'
                      AND b.status IN ('open', 'in_progress')) AS "openBugs",
                  (SELECT COUNT(*)::int FROM bugs b WHERE b.project_slug = p.slug AND b.source = 'production'
                      AND b.severity = 'critical' AND b.status IN ('open', 'in_progress')) AS "criticalBugs",
                  (SELECT COALESCE(SUM(k.count), 0)::int FROM production_events e
                     JOIN production_event_buckets k ON k.event_id = e.id
                    WHERE e.project_slug = p.slug AND k.hour >= date_trunc('hour', NOW() - INTERVAL '24 hours')) AS "last24h"
             FROM projects p LEFT JOIN production_status s ON s.project_slug = p.slug WHERE p.slug = $1`,
          [slug],
        )
      ).rows[0] as
        | {
            healthUrl: string | null;
            logsConfigured: boolean;
            ingestConfigured: boolean;
            down: boolean;
            criticalBugs: number;
          }
        | undefined;
      if (!row) return void response.status(404).json({ message: 'Projekt nicht gefunden.' });
      const configured = Boolean(row.healthUrl) || row.logsConfigured || row.ingestConfigured;
      const endpoint = ingestEndpoint(publicBaseUrl(request), slug);
      response.set('Cache-Control', 'no-store').json({
        production: { ...row, configured, healthy: !row.down && row.criticalBugs === 0 },
        snippets: { endpoint, browser: browserSnippet(endpoint), node: nodeSnippet(endpoint) },
      });
    } catch (error) {
      next(error);
    }
  });

  app.get('/bugs/:id/production', access({ tenant: 'bugs' }), async (request, response, next) => {
    try {
      if (!isUuid(request.params.id)) return void response.status(404).json({ message: 'Not found.' });
      const events = (
        await pool.query(
          `SELECT id, source, origin, fingerprint, first_seen AS "firstSeen", last_seen AS "lastSeen",
                  count::int AS count, sample, deploy_suspect AS "deploySuspect"
             FROM production_events WHERE bug_id = $1 ORDER BY last_seen DESC LIMIT 20`,
          [request.params.id],
        )
      ).rows;
      const history = (
        await pool.query<{ hour: Date; count: number }>(
          `SELECT k.hour, SUM(k.count)::int AS count
             FROM production_event_buckets k JOIN production_events e ON e.id = k.event_id
            WHERE e.bug_id = $1 AND k.hour >= date_trunc('hour', NOW()) - make_interval(hours => $2)
            GROUP BY k.hour ORDER BY k.hour`,
          [request.params.id, HISTORY_HOURS - 1],
        )
      ).rows;
      response.set('Cache-Control', 'no-store').json({ events, history: fillHistory(history) });
    } catch (error) {
      next(error);
    }
  });

  // Erzeugen und Rotieren: der Klartext wird genau einmal zurückgegeben, gespeichert wird nur der Hash.
  app.post(
    '/projects/:slug/ingest-token',
    access({ role: 'admin', tenant: 'project' }),
    async (request, response, next) => {
      try {
        const slug = parseProjectSlug(request.params.slug ?? '');
        const { token, hash } = createIngestToken();
        if (!slug) return void response.status(404).json({ message: 'Projekt nicht gefunden.' });
        const updated = await pool.query('UPDATE projects SET ingest_token_hash = $2 WHERE slug = $1', [slug, hash]);
        if (!updated.rowCount) return void response.status(404).json({ message: 'Projekt nicht gefunden.' });
        response
          .set('Cache-Control', 'no-store')
          .status(201)
          .json({ token, endpoint: ingestEndpoint(publicBaseUrl(request), slug, token) });
      } catch (error) {
        next(error);
      }
    },
  );

  app.delete(
    '/projects/:slug/ingest-token',
    access({ role: 'admin', tenant: 'project' }),
    async (request, response, next) => {
      try {
        const slug = parseProjectSlug(request.params.slug ?? '');
        if (!slug) return void response.status(404).json({ message: 'Projekt nicht gefunden.' });
        await pool.query('UPDATE projects SET ingest_token_hash = NULL WHERE slug = $1', [slug]);
        response.status(204).end();
      } catch (error) {
        next(error);
      }
    },
  );
}
