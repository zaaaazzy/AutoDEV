import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import express, { type ErrorRequestHandler, type Express, type RequestHandler } from 'express';
import type { Pool } from 'pg';
import { logOnce } from '../core/log.js';
import { isRecord, parseProjectSlug } from '../core/validation.js';
import { isExcluded, type ProductionError, recordEvent } from '../runner/production-events.js';
import { updateAlerts } from '../runner/production-monitor.js';
import { RateLimiter } from './security.js';

/**
 * Ingest-Endpunkt des Produktions-Rückkanals: POST /api/ingest/<projekt>/<token>. Läuft ohne Login – das Projekt
 * ergibt sich allein aus Slug und Token (Mandantentrennung). Gespeichert ist nur der SHA-256-Hash des Tokens.
 * Grenzen: 16 KB je Anfrage, Rate-Limit je Absender und je Projekt. Antworten sind immer JSON, Inhalte werden nie
 * zurückgegeben oder als HTML ausgeliefert.
 */
export const INGEST_LIMIT_BYTES = 16 * 1024;
export const INGEST_PATH = '/api/ingest/:project/:token';
const MESSAGE_MAX = 4000;
const STACK_MAX = 12_000;

export function hashIngestToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Neues Token (Klartext nur für die einmalige Anzeige) samt Hash zum Speichern. */
export function createIngestToken(): { token: string; hash: string } {
  const token = randomBytes(24).toString('base64url');
  return { token, hash: hashIngestToken(token) };
}

export function tokenMatches(token: string, hash: string | null | undefined): boolean {
  if (!hash || !/^[\w-]{16,128}$/.test(token)) return false;
  const actual = Buffer.from(hashIngestToken(token), 'hex');
  const expected = Buffer.from(hash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Meldung aus dem Snippet: JSON { message, stack?, url?, source? } oder einfacher Text. */
export function parseIngestBody(body: string): ProductionError | null {
  let payload: unknown = body;
  try {
    payload = JSON.parse(body);
  } catch {
    // einfacher Text: die ganze Nachricht ist die Meldung
  }
  const record = isRecord(payload) ? payload : { message: payload };
  const message = typeof record.message === 'string' ? record.message.trim() : '';
  const stack = typeof record.stack === 'string' ? record.stack : '';
  if (!message || message.length > MESSAGE_MAX || stack.length > STACK_MAX) return null;
  const source = typeof record.source === 'string' && /^(?:browser|node)$/.test(record.source) ? record.source : '';
  let path = '';
  if (typeof record.url === 'string') {
    try {
      path = new URL(record.url, 'http://app.invalid').pathname.slice(0, 160);
    } catch {
      path = '';
    }
  }
  return { source: 'ingest', message, stack, origin: [source, path].filter(Boolean).join(' ') };
}

export interface IngestLimits {
  perClient: RateLimiter;
  perProject: RateLimiter;
}

export function registerIngestRoutes(
  app: Express,
  pool: Pool,
  limits: IngestLimits = { perClient: new RateLimiter(60, 60_000), perProject: new RateLimiter(600, 60_000) },
): void {
  // Das Snippet läuft auf einer anderen Origin: einfache CORS-Freigabe ohne Cookies (der Token steht in der URL).
  const cors: RequestHandler = (_request, response, next) => {
    response.set({
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Cache-Control': 'no-store',
    });
    next();
  };
  app.options(INGEST_PATH, cors, (_request, response) => void response.status(204).end());

  const guard: RequestHandler = async (request, response, next) => {
    try {
      const slug = parseProjectSlug(String(request.params.project ?? ''));
      const client = request.ip ?? 'unbekannt';
      // Hinter Caddy/nginx ohne DEV_LOG_TRUST_PROXY ist request.ip die Proxy-Adresse: alle Absender teilen sich
      // dann das Limit je Absender.
      if (request.get('x-forwarded-for') && !request.app.get('trust proxy')) {
        logOnce(
          'ingest-trust-proxy',
          '[ingest] X-Forwarded-For ohne DEV_LOG_TRUST_PROXY: alle Absender teilen sich ein Rate-Limit.',
        );
      }
      const tooMany = () => void response.status(429).set('Retry-After', '60').json({ message: 'Zu viele Meldungen.' });
      if (!limits.perClient.allow(client)) return tooMany();
      if (Number(request.get('content-length') ?? 0) > INGEST_LIMIT_BYTES) {
        return void response.status(413).json({ message: 'Meldung grösser als 16 KB.' });
      }
      const project = slug
        ? (
            await pool.query<{ hash: string | null; ignore: string[] }>(
              'SELECT ingest_token_hash AS hash, production_ignore AS ignore FROM projects WHERE slug = $1',
              [slug],
            )
          ).rows[0]
        : undefined;
      // Unbekanntes Projekt und falsches oder rotiertes Token sehen gleich aus.
      if (!slug || !project || !tokenMatches(String(request.params.token ?? ''), project.hash)) {
        return void response.status(401).json({ message: 'Ungültiges Ingest-Token.' });
      }
      // Erst nach gültigem Token zählen: Müll-Anfragen mit bekanntem Slug verbrauchen das Projektlimit nicht.
      if (!limits.perProject.allow(slug)) return tooMany();
      response.locals.ingest = { slug, ignore: project.ignore ?? [] };
      next();
    } catch (error) {
      next(error);
    }
  };

  app.post(
    INGEST_PATH,
    cors,
    guard,
    express.text({ type: () => true, limit: INGEST_LIMIT_BYTES }),
    async (request, response, next) => {
      try {
        const { slug, ignore } = response.locals.ingest as { slug: string; ignore: string[] };
        const error = parseIngestBody(typeof request.body === 'string' ? request.body : '');
        if (!error) {
          return void response.status(400).json({ message: 'Erwartet: { "message": "…", "stack": "…" }.' });
        }
        if (isExcluded(`${error.message}\n${error.stack ?? ''}`, ignore)) {
          return void response.status(202).json({ accepted: true, ignored: true });
        }
        const result = await recordEvent(pool, slug, error);
        if (result.severity === 'critical') await updateAlerts(pool, slug).catch(() => undefined);
        response.status(202).json({ accepted: true });
      } catch (error) {
        next(error);
      }
    },
  );

  const failures: ErrorRequestHandler = (error: { status?: number; type?: string }, _request, response, next) => {
    if (response.headersSent) return next(error);
    if (error.type === 'entity.too.large' || error.status === 413) {
      return void response.status(413).json({ message: 'Meldung grösser als 16 KB.' });
    }
    console.error('Ingest fehlgeschlagen:', error instanceof Error ? error.message : error);
    response
      .status(error.status && error.status < 500 ? error.status : 500)
      .json({ message: 'Meldung fehlgeschlagen.' });
  };
  app.use('/api/ingest', failures);
}
