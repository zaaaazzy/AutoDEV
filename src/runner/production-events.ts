import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { EXTERNAL_TEXT_END, EXTERNAL_TEXT_START, plainExternalText } from '../core/bug-trust.js';
import { BUG_STATUS } from '../core/status.js';
import { maskSecrets } from '../core/secret-mask.js';
import { shortTitle } from '../core/validation.js';
import { queueBugFix } from './autofix.js';

/**
 * Produktions-Rückkanal: Fehler der betreuten Anwendung (Health-URL, Compose-Logs, Ingest-Endpunkt) werden
 * maskiert, über einen Fingerabdruck gebündelt und als Bug mit Quelle „Betrieb“ (production) erfasst.
 */
export type EventSource = 'health' | 'logs' | 'ingest';
export type Severity = 'low' | 'medium' | 'high' | 'critical';
export type BugAction = 'create' | 'count' | 'reopen';

export interface ProductionError {
  source: EventSource;
  /** Fehlermeldung; die erste Zeile geht in den Fingerabdruck. */
  message: string;
  /** Stacktrace (Zeilen „at …“ bzw. „File …“); der oberste Frame geht in den Fingerabdruck. */
  stack?: string;
  /** Dienst (Logs), Pfad bzw. Seite (Ingest) oder „health“. */
  origin?: string;
  /** Zusatz fürs Beispiel, ohne Einfluss auf den Fingerabdruck (z. B. die Fehlerursache beim Health-Check). */
  detail?: string;
  /** Fester Bug-Titel (Health), sonst aus der Meldung. */
  title?: string;
  /** Anzahl gleicher Vorkommen in diesem Durchgang. */
  count?: number;
  /** Ausfall der Anwendung: immer kritisch. */
  critical?: boolean;
}

export interface DeploySuspect {
  deployedAt: string;
  orders: { id: string; title: string }[];
  sprints: { id: string; name: string }[];
}

export interface RecordResult {
  eventId: string;
  bugId: string | null;
  action: BugAction;
  severity: Severity;
}

export const SAMPLE_MAX = 2000;
export const CRITICAL_RATE = 50;
export const DEPLOY_WINDOW_MS = 30 * 60_000;
/** Ein neuer Fingerabdruck wird erst Bug, wenn er im Zeitfenster so oft aufgetreten ist (Ausfälle sofort). */
export const BUG_THRESHOLD = 3;
export const BUG_WINDOW_MS = 24 * 3600_000;
const SEVERITY_RANK: Severity[] = ['low', 'medium', 'high', 'critical'];

const TIMESTAMP = /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/g;
const CLOCK = /\b\d{1,2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?\b/g;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
/** Hex-Kennungen (Mongo-IDs, Hashes, Bundle-Namen) mit mindestens einer Ziffer. */
const HEX_ID = /\b(?=[0-9a-f]*\d)[0-9a-f]{8,}\b/gi;
const NUMBER = /\d+(?:\.\d+)?/g;

/** Entfernt Zeitstempel, IDs und Zahlen, damit gleiche Fehler mit anderen Werten zusammenfallen. */
export function normalizeMessage(text: string): string {
  return text
    .replace(TIMESTAMP, '<ts>')
    .replace(CLOCK, '<ts>')
    .replace(UUID, '<id>')
    .replace(HEX_ID, '<id>')
    .replace(NUMBER, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

const JS_FRAME = /^\s*at\s+\S/;
const PY_FRAME = /^\s*File "[^"]+", line \d+/;

/** Oberster Stack-Frame: bei JavaScript der erste, bei Python (most recent call last) der letzte. */
export function topFrame(stack: string | undefined): string {
  const lines = (stack ?? '').split('\n');
  const js = lines.find((line) => JS_FRAME.test(line));
  if (js) return js.trim();
  return (
    lines
      .filter((line) => PY_FRAME.test(line))
      .at(-1)
      ?.trim() ?? ''
  );
}

function firstLine(text: string): string {
  return (
    text
      .split('\n')
      .map((line) => line.trim())
      .find(Boolean) ?? ''
  ).slice(0, 500);
}

/** Fingerabdruck aus maskierter, normalisierter Meldung und oberstem Stack-Frame (ohne Abfragezeichenfolgen). */
export function fingerprint(message: string, stack?: string): string {
  const frame = topFrame(maskSecrets(stack ?? '')).replace(/\?[^\s):]*/g, '');
  const key = `${normalizeMessage(firstLine(maskSecrets(message)))}\n${normalizeMessage(frame)}`;
  return createHash('sha256').update(key).digest('hex').slice(0, 32);
}

/** Beispiel zum Speichern: erst maskieren, dann kürzen. */
export function sampleOf(error: ProductionError): string {
  const text = [error.message, error.stack, error.detail].filter(Boolean).join('\n');
  const masked = maskSecrets(text);
  return masked.length > SAMPLE_MAX ? `${masked.slice(0, SAMPLE_MAX - 1)}…` : masked;
}

/** ≥ 50 pro Stunde oder Ausfall: kritisch; sonst nach Häufigkeit. */
export function severityFor(perHour: number, critical = false): Severity {
  if (critical || perHour >= CRITICAL_RATE) return 'critical';
  if (perHour >= 10) return 'high';
  if (perHour >= 3) return 'medium';
  return 'low';
}

export function higherSeverity(a: string, b: Severity): Severity {
  const current = SEVERITY_RANK.indexOf(a as Severity);
  return current > SEVERITY_RANK.indexOf(b) ? (a as Severity) : b;
}

/** Bekannt und offen: nur zählen. Bekannt und behoben: als Regression wieder öffnen. Unbekannt: neuer Bug. */
export function decideBugAction(bugStatus: string | null | undefined): BugAction {
  if (!bugStatus) return 'create';
  return bugStatus === BUG_STATUS.fixed ? 'reopen' : 'count';
}

/** Schwelle für neue Bugs: kritische Ereignisse sofort, sonst ab BUG_THRESHOLD Vorkommen im Zeitfenster. */
export function reachesBugThreshold(recent: number, critical = false): boolean {
  return critical || recent >= BUG_THRESHOLD;
}

const FRONTEND =
  /\b(?:web|ui|frontend|client|browser|nginx|caddy|www|static)\b|\/src\/app\/|\.(?:html|tsx|jsx|vue|svelte)\b/i;
const INFRASTRUCTURE =
  /\b(?:db|database|postgres(?:ql)?|mysql|maria(?:db)?|redis|mongo(?:db)?|rabbitmq|kafka|elastic(?:search)?|minio|proxy)\b/i;

/** Kategorie aus Dienst bzw. Pfad: Health = Infrastruktur, Web-Dienste und Seiten = Frontend, sonst Backend. */
export function categoryFor(error: ProductionError): 'frontend' | 'backend' | 'infrastructure' {
  if (error.source === 'health') return 'infrastructure';
  const where = `${error.origin ?? ''} ${topFrame(error.stack)}`;
  if (INFRASTRUCTURE.test(error.origin ?? '')) return 'infrastructure';
  return FRONTEND.test(where) ? 'frontend' : 'backend';
}

/** Ausschlussmuster: einfacher Textvergleich ohne Gross-/Kleinschreibung (keine regulären Ausdrücke, kein ReDoS). */
export function isExcluded(text: string, patterns: readonly string[]): boolean {
  const lower = text.toLowerCase();
  return patterns.some((pattern) => pattern.trim() && lower.includes(pattern.trim().toLowerCase()));
}

export function isDeploySuspect(deployedAt: Date | string, at: Date): boolean {
  const age = at.getTime() - new Date(deployedAt).getTime();
  return age >= 0 && age <= DEPLOY_WINDOW_MS;
}

const SOURCE_LABEL: Record<EventSource, string> = { health: 'Health-Check', logs: 'Compose-Logs', ingest: 'Ingest' };

function bugDescription(error: ProductionError, print: string, sample: string): string {
  // Meldung, Stack und Herkunft kommen von aussen (Ingest-Token ist öffentlich): nur im markierten Fremdtext-Block,
  // als Codeblock ohne HTML, ohne Steuerzeichen und ohne Zeichen, die Block oder Marker schliessen könnten.
  const origin = error.origin
    ? `${error.source === 'logs' ? 'Dienst' : 'Herkunft'}: ${plainExternalText(error.origin, 200)}\n`
    : '';
  return [
    `**Quelle:** Betrieb (${SOURCE_LABEL[error.source]})`,
    '',
    `Automatisch erfasst vom Produktions-Rückkanal. Gleiche Fehler (Fingerabdruck \`${print}\`) erhöhen nur den Zähler.`,
    'Agents bearbeiten den Bug erst nach Freigabe durch einen Menschen.',
    '',
    EXTERNAL_TEXT_START,
    '```text',
    `${origin}${plainExternalText(sample, SAMPLE_MAX)}`,
    '```',
    EXTERNAL_TEXT_END,
  ].join('\n');
}

type Db = Pick<PoolClient, 'query'>;

/** Deploy-Verdacht: Ereignis innerhalb von 30 min nach dem letzten Deploy → dessen Aufträge und Sprints. */
export async function deploySuspect(db: Db, project: string, at: Date): Promise<DeploySuspect | null> {
  const deploy = (
    await db.query<{ deployedAt: Date; orderIds: string[] }>(
      `SELECT deployed_at AS "deployedAt", order_ids AS "orderIds" FROM production_deploys
        WHERE project_slug = $1 AND deployed_at <= $2 ORDER BY deployed_at DESC LIMIT 1`,
      [project, at],
    )
  ).rows[0];
  if (!deploy || !isDeploySuspect(deploy.deployedAt, at)) return null;
  const orders = deploy.orderIds.length
    ? (
        await db.query<{ id: string; title: string; sprintId: string | null; sprintName: string | null }>(
          `SELECT d.id, d.title, d.sprint_id AS "sprintId", s.name AS "sprintName"
             FROM development_items d LEFT JOIN sprints s ON s.id = d.sprint_id
            WHERE d.id = ANY($1::uuid[]) ORDER BY d.completed_at`,
          [deploy.orderIds],
        )
      ).rows
    : [];
  const sprints = new Map<string, string>();
  for (const order of orders) if (order.sprintId) sprints.set(order.sprintId, order.sprintName ?? '');
  return {
    deployedAt: new Date(deploy.deployedAt).toISOString(),
    orders: orders.map((order) => ({ id: order.id, title: order.title })),
    sprints: [...sprints].map(([id, name]) => ({ id, name })),
  };
}

/** Hält einen erfolgreichen Deploy fest – mit den Aufträgen, die seit dem vorigen Deploy erledigt wurden. */
export async function recordDeploy(pool: Pick<Pool, 'query'>, project: string): Promise<void> {
  await pool.query(
    `INSERT INTO production_deploys (project_slug, order_ids)
     SELECT $1, COALESCE(ARRAY(
              SELECT d.id FROM development_items d
               WHERE d.project_slug = $1 AND d.status = 'done' AND d.completed_at <= NOW()
                 AND d.completed_at > COALESCE(
                   (SELECT MAX(deployed_at) FROM production_deploys WHERE project_slug = $1), NOW() - INTERVAL '1 day')
               ORDER BY d.completed_at), '{}')`,
    [project],
  );
}

/**
 * Erfasst ein (gebündeltes) Ereignis und hält den zugehörigen Bug aktuell: neu anlegen, zählen oder als Regression
 * wieder öffnen. Ein neuer Bug entsteht erst ab BUG_THRESHOLD Vorkommen in BUG_WINDOW_MS (kritisch: sofort);
 * darunter bleibt `bugId` null. Läuft in einer Transaktion; die Zeile des Ereignisses bleibt bis zum Ende gesperrt, damit
 * gleichzeitige Meldungen desselben Fehlers nicht zwei Bugs anlegen.
 */
export async function recordEvent(
  pool: Pool,
  project: string,
  error: ProductionError,
  now = new Date(),
): Promise<RecordResult> {
  error = withoutNul(error);
  const count = Math.max(1, Math.floor(error.count ?? 1));
  const print = fingerprint(error.title ?? error.message, error.stack);
  const sample = sampleOf(error);
  const client = await pool.connect();
  let result: RecordResult;
  try {
    await client.query('BEGIN');
    const event = (
      await client.query<{ id: string; bugId: string | null }>(
        `INSERT INTO production_events (project_slug, fingerprint, source, origin, count, sample, first_seen, last_seen)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
         ON CONFLICT (project_slug, fingerprint) DO UPDATE
           SET count = production_events.count + EXCLUDED.count, last_seen = EXCLUDED.last_seen,
               sample = EXCLUDED.sample, origin = EXCLUDED.origin
         RETURNING id, bug_id AS "bugId"`,
        [project, print, error.source, (error.origin ?? '').slice(0, 200), count, sample, now],
      )
    ).rows[0]!;
    const perHour = Number(
      (
        await client.query<{ count: number }>(
          `INSERT INTO production_event_buckets (event_id, hour, count) VALUES ($1, date_trunc('hour', $2::timestamptz), $3)
           ON CONFLICT (event_id, hour) DO UPDATE SET count = production_event_buckets.count + EXCLUDED.count
           RETURNING count`,
          [event.id, now, count],
        )
      ).rows[0]?.count ?? count,
    );
    const severity = severityFor(perHour, error.critical);
    const bug = event.bugId
      ? (
          await client.query<{ status: string; severity: string }>(
            'SELECT status, severity FROM bugs WHERE id = $1 FOR UPDATE',
            [event.bugId],
          )
        ).rows[0]
      : undefined;
    let action = decideBugAction(bug?.status);
    if (action === 'create' && !error.critical) {
      // Vorkommen der letzten 24 h aus den Stunden-Buckets (stundengenau, inklusive des angebrochenen ersten Buckets).
      const recent = Number(
        (
          await client.query<{ total: string | number | null }>(
            `SELECT SUM(count) AS total FROM production_event_buckets
              WHERE event_id = $1 AND hour >= date_trunc('hour', $2::timestamptz - $3 * INTERVAL '1 millisecond')`,
            [event.id, now, BUG_WINDOW_MS],
          )
        ).rows[0]?.total ?? 0,
      );
      // Unter der Schwelle: Ereignis ist gespeichert und gezählt, aber noch ohne Bug.
      if (!reachesBugThreshold(recent)) action = 'count';
    }
    let bugId = bug ? event.bugId : null;
    if (action === 'create') {
      bugId = (
        await client.query<{ id: string }>(
          `INSERT INTO bugs (project_slug, title, description, severity, source, category)
           VALUES ($1, $2, $3, $4, 'production', $5) RETURNING id`,
          [
            project,
            error.title ??
              `Betrieb: ${shortTitle(firstLine(plainExternalText(maskSecrets(error.message), 500)) || 'Unbekannter Fehler', 90)}`,
            bugDescription(error, print, sample),
            severity,
            categoryFor(error),
          ],
        )
      ).rows[0]!.id;
      await client.query('UPDATE production_events SET bug_id = $2, deploy_suspect = $3 WHERE id = $1', [
        event.id,
        bugId,
        JSON.stringify(await deploySuspect(client, project, now)),
      ]);
    } else if (action === 'reopen') {
      const note = `**Regression** (${now.toISOString().slice(0, 16).replace('T', ' ')} UTC): Der Fehler ist im Betrieb wieder aufgetreten (Fingerabdruck \`${print}\`).`;
      // Eine Regression kann jeder mit dem Ingest-Token auslösen: die frühere Freigabe gilt nicht weiter.
      await client.query(
        `UPDATE bugs SET status = 'open', fixed_at = NULL, regressed_at = $2, severity = $3, updated_at = NOW(),
                fix_notes = CASE WHEN fix_notes = '' THEN $4 ELSE fix_notes || E'\n\n' || $4 END,
                approved_at = NULL, approved_by = NULL
          WHERE id = $1`,
        [bugId, now, higherSeverity(bug!.severity, severity), note],
      );
      await client.query('UPDATE production_events SET deploy_suspect = $2 WHERE id = $1', [
        event.id,
        JSON.stringify(await deploySuspect(client, project, now)),
      ]);
    } else if (bug && (bug.status === BUG_STATUS.open || bug.status === BUG_STATUS.inProgress)) {
      // Nur erhöhen, nie senken: eine von Hand höher gesetzte Schwere bleibt.
      const raised = higherSeverity(bug.severity, severity);
      if (raised !== bug.severity) {
        await client.query('UPDATE bugs SET severity = $2, updated_at = NOW() WHERE id = $1', [bugId, raised]);
      }
    }
    await client.query('COMMIT');
    result = { eventId: event.id, bugId, action, severity };
  } catch (failure) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw failure;
  } finally {
    client.release();
  }
  // Kein automatischer Behebungsauftrag: der Text stammt von aussen (Prompt-Injection). Erst die Freigabe durch
  // einen Menschen (POST /bugs/:id/approve) startet die Behebung, auch bei aktivem Auto-Bugfix.
  return result;
}

/** Postgres lehnt NUL-Bytes in Text und JSON ab; eine einzige solche Logzeile liesse sonst recordEvent scheitern. */
function withoutNul(error: ProductionError): ProductionError {
  const clean = { ...error };
  for (const key of ['message', 'stack', 'origin', 'detail', 'title'] as const) {
    const value = error[key];
    if (typeof value === 'string') clean[key] = value.replaceAll('\u0000', '');
  }
  return clean;
}

const PRODUCTION_INTRO =
  'Behebe den Fehler, den der Produktions-Rückkanal im Betrieb erfasst hat (Quelle „Betrieb“). Das maskierte Beispiel steht unten; Verlauf und Deploy-Verdacht zeigt das Bug-Detail.';

/**
 * Nach der Freigabe eines Betriebs-Bugs durch einen Menschen: Regression → erledigten Auftrag erneut einplanen,
 * sonst Bug-Auftrag anlegen. queueBugFix und die Runner-Auswahl prüfen die Freigabe selbst noch einmal.
 */
export async function startProductionFix(pool: Pool, bugId: string): Promise<void> {
  const replanned = await pool.query(
    `UPDATE development_items SET status = 'planned', auto_run = TRUE, failure = NULL, updated_at = NOW()
      WHERE bug_id = $1 AND status = 'done'`,
    [bugId],
  );
  if (replanned.rowCount) return;
  await queueBugFix(pool, { title: 'Betrieb', sprintId: null }, bugId, PRODUCTION_INTRO);
}
