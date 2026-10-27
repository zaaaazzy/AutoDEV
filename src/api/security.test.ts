import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FailureLimiter, allowedHost, clientSource, trustProxySetting } from './security.js';

const MINUTE = 60 * 1000;

test('FailureLimiter blockt nach zu vielen Fehlversuchen und gibt nach dem Zeitfenster frei', () => {
  const limiter = new FailureLimiter();
  for (let attempt = 0; attempt < 10; attempt += 1) {
    limiter.recordFailure('a', 0);
  }
  assert.equal(limiter.isBlocked('a', 1000), true);
  assert.equal(limiter.isBlocked('b', 1000), false);
  assert.equal(limiter.isBlocked('a', 16 * 60 * 1000), false);
});

test('FailureLimiter.reset hebt die Sperre auf', () => {
  const limiter = new FailureLimiter();
  limiter.recordFailure('a');
  limiter.reset('a');
  assert.equal(limiter.isBlocked('a'), false);
});

test('FailureLimiter: steigende Wartezeit statt harter 15-Minuten-Sperre, höchstens 15 Minuten', () => {
  const limiter = new FailureLimiter();
  for (let attempt = 0; attempt < 10; attempt += 1) limiter.recordFailure('ip|devlog', 0);
  assert.equal(limiter.retryAfter('ip|devlog', undefined, 0), MINUTE, 'erste Wartezeit eine Minute');
  assert.equal(limiter.isBlocked('ip|devlog', MINUTE), false, 'nach einer Minute ist ein neuer Versuch möglich');
  limiter.recordFailure('ip|devlog', MINUTE);
  assert.equal(limiter.retryAfter('ip|devlog', undefined, MINUTE), 2 * MINUTE, 'jeder weitere Fehlversuch verdoppelt');
  let now = 3 * MINUTE;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    limiter.recordFailure('ip|devlog', now);
    assert.ok(limiter.retryAfter('ip|devlog', undefined, now) <= 15 * MINUTE, 'nie länger als 15 Minuten');
    now += 15 * MINUTE;
  }
});

test('FailureLimiter: Zufallsnamen von einer Herkunft werden vor der Passwortprüfung gebremst, andere nicht', () => {
  const limiter = new FailureLimiter();
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const key = `198.51.100.9|zufall-${attempt}`;
    assert.equal(limiter.isBlocked(key, 1000, '198.51.100.9'), false);
    limiter.recordFailure(key, 1000, '198.51.100.9');
  }
  assert.equal(limiter.isBlocked('198.51.100.9|noch-einer', 1000, '198.51.100.9'), true, 'Limit je Herkunft greift');
  assert.equal(limiter.isBlocked('203.0.113.1|devlog', 1000, '203.0.113.1'), false, 'Admin von anderer Adresse frei');
  assert.equal(
    limiter.isBlocked('198.51.100.9|noch-einer', 1000 + MINUTE, '198.51.100.9'),
    false,
    'nach dem Fenster frei',
  );
});

test('FailureLimiter: Fehlversuche für den Admin-Namen sperren ihn nicht von einer anderen Adresse aus', () => {
  const limiter = new FailureLimiter();
  for (let attempt = 0; attempt < 50; attempt += 1) limiter.recordFailure('198.51.100.9|devlog', 0, '198.51.100.9');
  assert.equal(limiter.isBlocked('203.0.113.1|devlog', 1000, '203.0.113.1'), false);
});

test('FailureLimiter: der Speicher bleibt bei Massen-Logins mit Zufallsnamen begrenzt', () => {
  const limiter = new FailureLimiter({ maxEntries: 100 });
  for (let attempt = 0; attempt < 5000; attempt += 1) {
    const source = `10.0.${Math.floor(attempt / 250)}.${attempt % 250}`;
    limiter.recordFailure(`${source}|name-${attempt}`, attempt, source);
  }
  assert.ok(limiter.size <= 200, `höchstens 2 × 100 Einträge, gefunden ${limiter.size}`);
});

test('FailureLimiter: abgelaufene Einträge werden beim Einfügen aufgeräumt', () => {
  const limiter = new FailureLimiter({ maxEntries: 10 });
  for (let attempt = 0; attempt < 10; attempt += 1) limiter.recordFailure(`alt-${attempt}`, 0);
  limiter.recordFailure('neu', 16 * MINUTE);
  assert.equal(limiter.size, 1);
});

test('trustProxySetting: benannte Netze, IP/CIDR oder genau ein Hop, nie true oder mehrere Hops', () => {
  assert.equal(trustProxySetting('uniquelocal'), 'uniquelocal');
  assert.equal(trustProxySetting(' loopback , 172.18.0.0/16 '), 'loopback,172.18.0.0/16');
  assert.equal(trustProxySetting('fd00::/8'), 'fd00::/8');
  assert.equal(trustProxySetting(' 1 '), 1, 'als Zahl, sonst hielte Express "1" für eine Adresse');
  assert.equal(trustProxySetting('true'), null);
  assert.equal(trustProxySetting('*'), null);
  assert.equal(trustProxySetting('0'), null);
  assert.equal(trustProxySetting('2'), null);
  assert.equal(trustProxySetting('1,loopback'), null);
  assert.equal(trustProxySetting('10.0.0.0/33'), null);
  assert.equal(trustProxySetting('loopback,true'), null, 'ein ungültiger Teil verwirft alles');
  assert.equal(trustProxySetting(''), null);
  assert.equal(trustProxySetting(undefined), null);
});

test('clientSource: IPv4-mapped IPv6 wie IPv4, IPv6 je /64, fehlende Adresse', () => {
  assert.equal(clientSource('::ffff:192.0.2.7'), '192.0.2.7');
  assert.equal(clientSource('192.0.2.7'), '192.0.2.7');
  assert.equal(clientSource('2001:db8:1:2::1'), clientSource('2001:db8:1:2:ffff:ffff:ffff:ffff'));
  assert.notEqual(clientSource('2001:db8:1:2::1'), clientSource('2001:db8:1:3::1'));
  assert.equal(clientSource('2001:0db8:0001:0002:0:0:0:1'), '2001:db8:1:2::/64');
  assert.equal(clientSource('::1'), '0:0:0:0::/64');
  assert.equal(clientSource(undefined), 'unknown');
  assert.equal(clientSource(''), 'unknown');
});

test('allowedHost: IPs, localhost, *.local und eigene Domains, keine fremden Namen (DNS-Rebinding)', () => {
  const environment = {
    DEV_LOG_DOMAIN: 'aideation.example.ch',
    DEV_LOG_ALLOWED_HOSTS: 'mac.tail1234.ts.net, Extra.Example',
  };
  for (const host of [
    '127.0.0.1:3100',
    'localhost:3100',
    'LOCALHOST',
    '[::1]:3100',
    '192.168.1.20:3100',
    'app.localhost:4200',
    'patricks-mac.local:3100',
    'aideation.example.ch',
    'aideation.example.ch.',
    'mac.tail1234.ts.net:3100',
    'extra.example',
  ]) {
    assert.equal(allowedHost(host, environment), true, host);
  }
  for (const host of [
    undefined,
    '',
    'evil.example:3100',
    'aideation.example.ch.evil.example',
    'localhost.evil.example',
  ]) {
    assert.equal(allowedHost(host, environment), false, String(host));
  }
  assert.equal(allowedHost('aideation.example.ch', {}), false, 'ohne DEV_LOG_DOMAIN keine Domain');
});
