/* global self, URL */
// Service Worker von AIdeation: zeigt Push-Nachrichten an und öffnet beim Antippen die passende Ansicht.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data;
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : '' };
  }
  event.waitUntil(
    self.registration.showNotification(data.title || 'AIdeation', {
      body: data.body || '',
      tag: data.tag,
      renotify: Boolean(data.tag),
      icon: 'icons/icon-192.png',
      badge: 'icons/icon-192.png',
      data: { url: data.url || './' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || './', self.registration.scope).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      for (const client of windows) {
        if ('focus' in client) {
          // Offene App: Link per Nachricht übergeben – sie wechselt Projekt und Seite auch dann, wenn der Hash schon
          // stimmt (reines Setzen des Hashes löst dann nichts aus). Andere Seiten im Scope werden umgeleitet.
          if (new URL(client.url).pathname === new URL(target).pathname)
            client.postMessage({ type: 'open', url: target });
          else if ('navigate' in client) client.navigate(target).catch(() => undefined);
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});
