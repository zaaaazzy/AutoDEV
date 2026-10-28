import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pool } from 'pg';
import webpush from 'web-push';
import {
  VapidKeyMissingError,
  deliverPush,
  isAllowedPushEndpoint,
  pushSubject,
  sealStoredVapidKeys,
  vapidKeys,
} from './push.js';
import { isEncrypted } from './secrets.js';

test('Push-Endpunkte: nur bekannte Push-Dienste per https ohne Port und Zugangsdaten', () => {
  for (const ok of [
    'https://fcm.googleapis.com/fcm/send/abc:def',
    'https://updates.push.services.mozilla.com/wpush/v2/xyz',
    'https://web.push.apple.com/QF1x',
    'https://wns2-par02p.notify.windows.com/w/?token=abc',
    'https://FCM.googleapis.com:443/fcm/send/abc',
  ])
    assert.equal(isAllowedPushEndpoint(ok), true, ok);
  for (const bad of [
    'https://192.168.1.1/push',
    'https://127.0.0.1:5432/',
    'https://169.254.169.254/latest/meta-data',
    'https://localhost/push',
    'https://[::1]/push',
    'https://[fd00::1]/push',
    'https://[fe80::1]/push',
    'https://[::ffff:192.168.1.1]/push',
    'https://10.0.0.1/push',
    'http://fcm.googleapis.com/fcm/send/abc',
    'https://fcm.googleapis.com:8443/fcm/send/abc',
    'https://user:pass@fcm.googleapis.com/fcm/send/abc',
    'https://user@fcm.googleapis.com/fcm/send/abc',
    'https://fcm.googleapis.com@192.168.1.1/',
    'https://evil-push.apple.com.attacker.tld/',
    'https://evilpush.apple.com/',
    'https://push.apple.com.attacker.tld/',
    'https://attacker.tld/?fcm.googleapis.com',
    'https://fcm.googleapis.com.attacker.tld/',
    'https://fcm.googleapis.com./fcm/send/abc',
    `https://fcm.googleapis.com/${'a'.repeat(1000)}`,
    'kein url',
    '',
    42,
    undefined,
  ])
    assert.equal(isAllowedPushEndpoint(bad), false, String(bad));
});

test('deliverPush fragt ungültige Endpunkte nie an und meldet sie zum Löschen', async () => {
  const requested: string[] = [];
  const send = (async (subscription: { endpoint: string }) => {
    requested.push(subscription.endpoint);
    return {};
  }) as unknown as Parameters<typeof deliverPush>[3];
  const valid = { endpoint: 'https://fcm.googleapis.com/fcm/send/ok', p256dh: 'p', auth: 'a' };
  const lan = { endpoint: 'https://192.168.1.1/scan', p256dh: 'p', auth: 'a' };
  const result = await deliverPush(
    { publicKey: 'pub', privateKey: 'priv' },
    [valid, lan],
    { title: 'T', body: 'B' },
    send,
  );
  assert.deepEqual(requested, [valid.endpoint]);
  assert.deepEqual(result, { sent: 1, gone: [lan.endpoint] });
});

test('Push-Absender: öffentliche Adresse aus Umgebung oder .env, nie localhost', () => {
  const none = () => undefined;
  assert.equal(pushSubject({ DEV_LOG_PUBLIC_URL: 'https://dev.example.ch' }, none), 'https://dev.example.ch');
  assert.equal(pushSubject({ DEV_LOG_DOMAIN: 'dev.example.ch' }, none), 'https://dev.example.ch');
  assert.equal(
    pushSubject({}, (key) => (key === 'DEV_LOG_DOMAIN' ? 'log.example.ch' : undefined)),
    'https://log.example.ch',
  );
  assert.doesNotMatch(pushSubject({}, none), /localhost/);
});

const KEY = { DEV_LOG_SECRET_KEY: 'ein-schluessel-nur-fuer-tests' };

/** app_settings im Speicher, mit denselben Bedingungen wie in Postgres (ON CONFLICT DO NOTHING, UPDATE … AND value). */
function settings(initial?: string) {
  const values = new Map<string, string>(initial === undefined ? [] : [['push_vapid_keys', initial]]);
  const pool = {
    query: async (sql: string, params: string[]) => {
      if (sql.startsWith('SELECT')) {
        const value = values.get(params[0]!);
        return { rows: value === undefined ? [] : [{ value }] };
      }
      if (sql.startsWith('INSERT')) {
        if (!values.has(params[0]!)) values.set(params[0]!, params[1]!);
        return { rows: [], rowCount: 1 };
      }
      if (values.get(params[0]!) !== params[2]) return { rows: [], rowCount: 0 };
      values.set(params[0]!, params[1]!);
      return { rows: [], rowCount: 1 };
    },
  } as unknown as Pool;
  return { pool, stored: () => values.get('push_vapid_keys') };
}

test('VAPID: neue Schlüssel liegen nur verschlüsselt in der Datenbank', async () => {
  const db = settings();
  const keys = await vapidKeys(db.pool, KEY);
  const stored = db.stored()!;
  assert.ok(isEncrypted(stored), 'mit Präfix gespeichert');
  assert.ok(!stored.includes(keys.privateKey), 'privater Schlüssel nicht im Klartext');
  assert.ok(!stored.includes(keys.publicKey));
  assert.deepEqual(await vapidKeys(db.pool, KEY), keys, 'derselbe Schlüssel beim nächsten Aufruf');
});

test('VAPID: ohne DEV_LOG_SECRET_KEY wird kein Schlüssel geschrieben', async () => {
  const db = settings();
  await assert.rejects(vapidKeys(db.pool, {}), VapidKeyMissingError);
  assert.equal(db.stored(), undefined);
});

test('VAPID beim Start: Klartext wird einmal verschlüsselt, danach bleibt alles gleich', async () => {
  const keys = webpush.generateVAPIDKeys();
  const db = settings(JSON.stringify(keys));
  assert.equal(await sealStoredVapidKeys(db.pool, KEY), 1);
  const sealed = db.stored()!;
  assert.ok(isEncrypted(sealed));
  assert.ok(!sealed.includes(keys.privateKey));
  assert.deepEqual(await vapidKeys(db.pool, KEY), keys, 'Geräte behalten ihr Abo (gleicher Schlüssel)');
  assert.equal(await sealStoredVapidKeys(db.pool, KEY), 0, 'zweiter Start ändert nichts');
  assert.equal(db.stored(), sealed);
});

test('VAPID beim Start: ohne oder mit falschem Schlüssel laut abbrechen, nichts löschen', async () => {
  const plain = JSON.stringify(webpush.generateVAPIDKeys());
  const db = settings(plain);
  await assert.rejects(sealStoredVapidKeys(db.pool, {}), /DEV_LOG_SECRET_KEY/);
  assert.equal(db.stored(), plain, 'Wert bleibt erhalten');

  const sealed = settings();
  await vapidKeys(sealed.pool, KEY);
  const before = sealed.stored();
  await assert.rejects(
    sealStoredVapidKeys(sealed.pool, { DEV_LOG_SECRET_KEY: 'ein-ganz-anderer-schluessel' }),
    /nicht lesen/,
  );
  assert.equal(sealed.stored(), before);

  assert.equal(await sealStoredVapidKeys(settings().pool, {}), 0, 'ohne gespeicherten Schlüssel kein Abbruch');
});
