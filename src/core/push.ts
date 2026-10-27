import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import webpush from 'web-push';
import { readEnvValues } from './local-database.js';
import { decryptSecret, encryptSecret, isEncrypted } from './secrets.js';

/** Web-Push an alle registrierten Geräte. Server, Worker und Wächter teilen die VAPID-Schlüssel über die Datenbank. */
export interface PushMessage {
  title: string;
  body: string;
  /** Ziel beim Antippen, relativ zur App (z. B. „#development“). */
  url?: string;
  /** Gleiche Tags ersetzen sich auf dem Gerät statt sich zu stapeln. */
  tag?: string;
}

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

export interface PushSubscriptionRow {
  endpoint: string;
  p256dh: string;
  auth: string;
}

const VAPID_KEY = 'push_vapid_keys';

/** Push-Dienste der Browser: exakte Hosts (Chrome/Edge über FCM, Firefox) und Domains mit Unterdomänen (Safari, Windows). */
const PUSH_HOSTS = new Set(['fcm.googleapis.com', 'updates.push.services.mozilla.com']);
const PUSH_DOMAINS = ['push.apple.com', 'notify.windows.com'];

/**
 * Nur Endpunkte bekannter Push-Dienste – sonst schickt der Server POST-Anfragen an beliebige Ziele (SSRF, z. B. ins
 * LAN). Allowlist statt IP-Blocklist, weil DNS-Rebinding eine Blocklist umgeht. Gilt beim Anmelden und beim Senden.
 */
export function isAllowedPushEndpoint(endpoint: unknown): endpoint is string {
  if (typeof endpoint !== 'string' || endpoint.length > 1000) return false;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  // `new URL` normalisiert Port 443 zu '' und Hosts zu Kleinbuchstaben.
  if (url.protocol !== 'https:' || url.username || url.password || url.port !== '') return false;
  const host = url.hostname;
  return PUSH_HOSTS.has(host) || PUSH_DOMAINS.some((domain) => host.endsWith(`.${domain}`));
}
/** Wert aus der .env der Installation (Worker und Wächter laufen über launchd ohne diese Umgebung). */
function installEnv(key: string): string | undefined {
  const values = readEnvValues(resolve(dirname(fileURLToPath(import.meta.url)), '../..'));
  return values.get(key)?.trim() || undefined;
}

/**
 * Absender der Push-Nachrichten (VAPID „subject“). Apple lehnt „localhost“ ab (403 BadJwtToken) – deshalb die
 * öffentliche Adresse, auch aus der .env, wenn der Prozess sie nicht in der Umgebung hat.
 */
export function pushSubject(environment: NodeJS.ProcessEnv = process.env, fromFile = installEnv): string {
  const url = environment.DEV_LOG_PUBLIC_URL?.trim() || fromFile('DEV_LOG_PUBLIC_URL');
  if (url) return url;
  const domain = environment.DEV_LOG_DOMAIN?.trim() || fromFile('DEV_LOG_DOMAIN');
  return domain ? `https://${domain}` : 'mailto:devlog@example.com';
}

const SUBJECT = pushSubject();

/** Ohne DEV_LOG_SECRET_KEY wird kein privater VAPID-Schlüssel gespeichert. */
export class VapidKeyMissingError extends Error {
  constructor() {
    super('Push-Schlüssel brauchen DEV_LOG_SECRET_KEY. Den Schlüssel in der .env setzen und neu starten.');
  }
}

/** VAPID-Schlüssel kommen nur verschlüsselt in die Datenbank; ohne Schlüssel wird nichts geschrieben (fail-closed). */
export function sealVapid(keys: VapidKeys, environment: NodeJS.ProcessEnv = process.env): string {
  const sealed = encryptSecret(JSON.stringify(keys), environment);
  if (!isEncrypted(sealed)) throw new VapidKeyMissingError();
  return sealed;
}

/** Liest gespeicherte VAPID-Schlüssel; Klartext aus der Zeit vor der Verschlüsselung bleibt bis zum Start lesbar. */
export function openVapid(stored: string, environment: NodeJS.ProcessEnv = process.env): VapidKeys {
  return JSON.parse(decryptSecret(stored, environment)) as VapidKeys;
}

export async function vapidKeys(pool: Pool, environment: NodeJS.ProcessEnv = process.env): Promise<VapidKeys> {
  const stored = await pool.query<{ value: string }>('SELECT value FROM app_settings WHERE key = $1', [VAPID_KEY]);
  if (stored.rows[0]) return openVapid(stored.rows[0].value, environment);
  const generated = webpush.generateVAPIDKeys();
  await pool.query('INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING', [
    VAPID_KEY,
    sealVapid(generated, environment),
  ]);
  // Bei gleichzeitiger Erzeugung gewinnt der zuerst gespeicherte Schlüssel.
  const winner = await pool.query<{ value: string }>('SELECT value FROM app_settings WHERE key = $1', [VAPID_KEY]);
  return openVapid(winner.rows[0]!.value, environment);
}

/**
 * Beim Start: VAPID-Schlüssel aus der Zeit vor der Verschlüsselung einmal verschlüsselt neu schreiben; vorhandene
 * müssen sich mit dem Schlüssel lesen lassen. Liegt ein Schlüssel vor, aber kein DEV_LOG_SECRET_KEY, startet der
 * Dienst nicht – gelöscht wird nichts. Gibt die Zahl der neu verschlüsselten Werte zurück (0 oder 1).
 */
export async function sealStoredVapidKeys(pool: Pool, environment: NodeJS.ProcessEnv = process.env): Promise<number> {
  const result = await pool.query<{ value: string }>('SELECT value FROM app_settings WHERE key = $1', [VAPID_KEY]);
  const stored = result.rows[0]?.value;
  if (!stored) return 0;
  if (!environment.DEV_LOG_SECRET_KEY?.trim()) throw new VapidKeyMissingError();
  if (isEncrypted(stored)) {
    try {
      openVapid(stored, environment);
    } catch {
      throw new Error('Push-Schlüssel lassen sich mit dem gesetzten DEV_LOG_SECRET_KEY nicht lesen.');
    }
    return 0;
  }
  const value = sealVapid(openVapid(stored, environment), environment);
  // Nur ersetzen, was noch der gelesene Klartext ist (ein gleichzeitiger Start hat es sonst schon erledigt).
  const updated = await pool.query('UPDATE app_settings SET value = $2 WHERE key = $1 AND value = $3', [
    VAPID_KEY,
    value,
    stored,
  ]);
  return updated.rowCount ?? 0;
}

/**
 * Empfänger (Mandantentrennung): Nachrichten eines Projekts gehen nur an Geräte von Administratoren und
 * freigeschalteten Benutzern; ohne Projekt (Systemmeldungen) nur an Administratoren; `self` nur an die eigenen Geräte.
 */
export type PushAudience = { project?: string } | { self: { id: string | null } };

export async function loadSubscriptions(pool: Pool, audience: PushAudience = {}): Promise<PushSubscriptionRow[]> {
  if ('self' in audience) {
    return (
      await pool.query<PushSubscriptionRow>(
        `SELECT endpoint, p256dh, auth FROM push_subscriptions
          WHERE CASE WHEN $1::uuid IS NULL THEN system_admin ELSE user_id = $1 END`,
        [audience.self.id],
      )
    ).rows;
  }
  return (
    await pool.query<PushSubscriptionRow>(
      `SELECT s.endpoint, s.p256dh, s.auth FROM push_subscriptions s LEFT JOIN users u ON u.id = s.user_id
        WHERE s.system_admin
           OR (u.active AND ('admin' = ANY(u.roles)
               OR ($1::text IS NOT NULL AND EXISTS (
                     SELECT 1 FROM project_members m WHERE m.user_id = u.id AND m.project_slug = $1))))`,
      [audience.project ?? null],
    )
  ).rows;
}

/**
 * Sendet an die übergebenen Geräte. Liefert die Zahl erfolgreicher Zustellungen und die Endpunkte, die der
 * Push-Dienst als abgemeldet meldet (404/410) – diese sollte der Aufrufer löschen. Endpunkte außerhalb der
 * Allowlist (Altdaten, Zwischenspeicher des Wächters) werden nie angefragt und ebenfalls als `gone` gemeldet.
 */
export async function deliverPush(
  keys: VapidKeys,
  subscriptions: PushSubscriptionRow[],
  message: PushMessage,
  send: typeof webpush.sendNotification = webpush.sendNotification.bind(webpush),
): Promise<{ sent: number; gone: string[] }> {
  const payload = JSON.stringify({ ...message, title: message.title.slice(0, 120), body: message.body.slice(0, 400) });
  let sent = 0;
  const gone = subscriptions.filter((s) => !isAllowedPushEndpoint(s.endpoint)).map((s) => s.endpoint);
  await Promise.all(
    subscriptions.filter((s) => isAllowedPushEndpoint(s.endpoint)).map(async (subscription) => {
      try {
        await send(
          { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } },
          payload,
          { vapidDetails: { subject: SUBJECT, ...keys }, TTL: 6 * 3600, urgency: 'normal', timeout: 10_000 },
        );
        sent += 1;
      } catch (error) {
        const status = (error as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) gone.push(subscription.endpoint);
        else console.warn('Push fehlgeschlagen:', (error as Error).message);
      }
    }),
  );
  return { sent, gone };
}

/** Sendet eine Nachricht an alle Geräte; Fehler werden nur protokolliert, damit Abläufe nie daran scheitern. */
export async function sendPush(pool: Pool, message: PushMessage, audience: PushAudience = {}): Promise<number> {
  try {
    const subscriptions = await loadSubscriptions(pool, audience);
    if (!subscriptions.length) return 0;
    const { sent, gone } = await deliverPush(await vapidKeys(pool), subscriptions, message);
    if (gone.length) await pool.query('DELETE FROM push_subscriptions WHERE endpoint = ANY($1)', [gone]);
    return sent;
  } catch (error) {
    console.warn('Push nicht möglich:', (error as Error).message);
    return 0;
  }
}
