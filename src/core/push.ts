import type { Pool } from 'pg';
import webpush from 'web-push';

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
const SUBJECT =
  process.env.DEV_LOG_PUBLIC_URL?.trim() ||
  (process.env.DEV_LOG_DOMAIN?.trim() ? `https://${process.env.DEV_LOG_DOMAIN.trim()}` : 'mailto:devlog@localhost');

export async function vapidKeys(pool: Pool): Promise<VapidKeys> {
  const stored = await pool.query<{ value: string }>('SELECT value FROM app_settings WHERE key = $1', [VAPID_KEY]);
  if (stored.rows[0]) return JSON.parse(stored.rows[0].value) as VapidKeys;
  const generated = webpush.generateVAPIDKeys();
  await pool.query('INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING', [
    VAPID_KEY,
    JSON.stringify(generated),
  ]);
  // Bei gleichzeitiger Erzeugung gewinnt der zuerst gespeicherte Schlüssel.
  const winner = await pool.query<{ value: string }>('SELECT value FROM app_settings WHERE key = $1', [VAPID_KEY]);
  return JSON.parse(winner.rows[0]!.value) as VapidKeys;
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
 * Push-Dienst als abgemeldet meldet (404/410) – diese sollte der Aufrufer löschen.
 */
export async function deliverPush(
  keys: VapidKeys,
  subscriptions: PushSubscriptionRow[],
  message: PushMessage,
): Promise<{ sent: number; gone: string[] }> {
  const payload = JSON.stringify({ ...message, title: message.title.slice(0, 120), body: message.body.slice(0, 400) });
  let sent = 0;
  const gone: string[] = [];
  await Promise.all(
    subscriptions.map(async (subscription) => {
      try {
        await webpush.sendNotification(
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
