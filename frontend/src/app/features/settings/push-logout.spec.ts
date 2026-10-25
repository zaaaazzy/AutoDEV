import assert from 'node:assert/strict';
import { test } from 'node:test';
import { logoutWithPush, type DeviceSubscription } from './push-logout.js';

const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/abc';

function recorder(fail: (url: string) => boolean = () => false) {
  const calls: { url: string; body?: unknown }[] = [];
  const post = async (url: string, body?: unknown) => {
    calls.push({ url, body });
    if (fail(url)) throw new Error('Netzwerk');
    return {};
  };
  return { calls, post };
}

test('Logout meldet das Push-Abo am Server und im Browser ab, bevor die Sitzung endet', async () => {
  const { calls, post } = recorder();
  let unsubscribed = false;
  const subscription: DeviceSubscription = {
    endpoint: ENDPOINT,
    unsubscribe: async () => (unsubscribed = true),
  };
  await logoutWithPush({ subscription: async () => subscription, post });
  assert.deepEqual(calls, [
    { url: '/api/push/unsubscribe', body: { endpoint: ENDPOINT } },
    { url: '/api/logout', body: { endpoint: ENDPOINT } },
  ]);
  assert.equal(unsubscribed, true);
});

test('Logout: Fehler im Browser-Teil oder beim Abmelden des Abos blockieren den Logout nicht', async () => {
  const broken = recorder();
  await logoutWithPush({
    subscription: async () => {
      throw new Error('kein Service Worker');
    },
    post: broken.post,
  });
  assert.deepEqual(broken.calls, [{ url: '/api/logout', body: {} }]);

  const failing = recorder((url) => url === '/api/push/unsubscribe');
  await logoutWithPush({
    subscription: async () => ({
      endpoint: ENDPOINT,
      unsubscribe: async () => {
        throw new Error('Browser');
      },
    }),
    post: failing.post,
  });
  // Der Server bekommt den Endpunkt trotzdem mit dem Logout und löscht das eigene Abo.
  assert.deepEqual(failing.calls.at(-1), { url: '/api/logout', body: { endpoint: ENDPOINT } });
});

test('Logout ohne Push-Abo meldet nur die Sitzung ab', async () => {
  const { calls, post } = recorder();
  await logoutWithPush({ subscription: async () => null, post });
  assert.deepEqual(calls, [{ url: '/api/logout', body: {} }]);
});
