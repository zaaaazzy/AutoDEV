import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deliverPush, isAllowedPushEndpoint, pushSubject } from './push.js';

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
