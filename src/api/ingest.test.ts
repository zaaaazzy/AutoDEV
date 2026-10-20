import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { FakeProductionDb } from '../runner/production-fake-db.test.js';
import { createDevLogApp } from './app.js';
import { hashIngestToken, parseIngestBody, tokenMatches } from './ingest.js';

const auth = { username: 'dev-log-user', password: 'a-long-enough-local-password' };
const basic = `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}`;
const TOKEN = 'k3Y9-ingest-token-fuer-tests';

async function withApp(db: FakeProductionDb, action: (url: string) => Promise<void>): Promise<void> {
  const server = createDevLogApp(db.pool, auth).listen(0, '127.0.0.1');
  try {
    await new Promise<void>((resolve) => server.once('listening', resolve));
    await action(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

const report = (url: string, token = TOKEN, body: string = JSON.stringify({ message: 'TypeError: x is undefined' })) =>
  fetch(`${url}/api/ingest/shop/${token}`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body });

test('Ingest ohne Login mit gültigem Token; alle anderen Routen bleiben geschützt', async () => {
  const db = new FakeProductionDb({ tokenHash: hashIngestToken(TOKEN) });
  await withApp(db, async (url) => {
    const accepted = await fetch(`${url}/api/ingest/shop/${TOKEN}`, {
      method: 'POST',
      // Das Snippet läuft auf einer anderen Origin – die Herkunftsprüfung gilt hier nicht.
      headers: { 'Content-Type': 'application/json', Origin: 'https://shop.example.ch' },
      body: JSON.stringify({
        message: 'Login für anna@example.ch fehlgeschlagen <script>x</script>',
        url: 'https://shop.example.ch/kasse?id=1',
      }),
    });
    assert.equal(accepted.status, 202);
    assert.match(accepted.headers.get('content-type') ?? '', /application\/json/);
    const text = await accepted.text();
    assert.doesNotMatch(text, /anna|script/, 'Inhalte werden nie zurückgegeben');
    assert.equal(db.events.length, 1);
    assert.equal(db.events[0]!.origin, '/kasse');
    assert.ok(!db.events[0]!.sample.includes('anna@example.ch'), 'E-Mail maskiert');
    // Unter der Schwelle: gültige Antwort ohne Bug-Verweis, nur gezählt.
    assert.deepEqual(JSON.parse(text), { accepted: true });
    assert.equal(db.events[0]!.bugId, null);
    assert.equal(db.bugs.length, 0);

    for (const [method, path] of [
      ['GET', '/api/projects'],
      ['GET', '/api/projects/shop/production'],
      ['POST', '/api/projects/shop/ingest-token'],
      ['GET', `/api/ingest/shop/${TOKEN}`],
      ['POST', `/api/ingest/shop/${TOKEN}/extra`],
    ] as const) {
      assert.equal((await fetch(`${url}${path}`, { method })).status, 401, `${method} ${path}`);
    }
  });
});

test('Ingest: erst die dritte gleiche Meldung legt einen Bug an', async () => {
  const db = new FakeProductionDb({ tokenHash: hashIngestToken(TOKEN) });
  await withApp(db, async (url) => {
    for (let index = 1; index <= 3; index += 1) {
      const response = await report(url);
      assert.equal(response.status, 202);
      assert.deepEqual(await response.json(), { accepted: true });
      assert.equal(db.bugs.length, index < 3 ? 0 : 1, `nach ${index} Meldungen`);
    }
    assert.equal(db.events[0]!.count, 3);
    assert.equal(db.events[0]!.bugId, db.bugs[0]!.id);
    assert.equal(db.bugs[0]!.source, 'production');
    assert.equal(db.bugs[0]!.status, 'open');
  });
});

test('Ungültiges oder rotiertes Token: 401 und kein Ereignis', async () => {
  const db = new FakeProductionDb({ tokenHash: hashIngestToken(TOKEN) });
  await withApp(db, async (url) => {
    assert.equal((await report(url, 'falsches-token-0123456789')).status, 401);
    assert.equal((await fetch(`${url}/api/ingest/unbekannt/${TOKEN}`, { method: 'POST', body: 'x' })).status, 401);
    // Rotieren: neues Token erzeugen, das alte gilt nicht mehr.
    const rotated = await fetch(`${url}/api/projects/shop/ingest-token`, {
      method: 'POST',
      headers: { Authorization: basic },
    });
    assert.equal(rotated.status, 201);
    const { token, endpoint } = (await rotated.json()) as { token: string; endpoint: string };
    assert.match(endpoint, new RegExp(`/api/ingest/shop/${token}$`));
    assert.equal((await report(url)).status, 401);
    assert.equal(db.events.length, 0);
    assert.equal((await report(url, token)).status, 202);
    assert.equal(db.events.length, 1);
  });
});

test('In der Datenbank steht vom Ingest-Token nur der Hash', async () => {
  const db = new FakeProductionDb();
  await withApp(db, async (url) => {
    const created = await fetch(`${url}/api/projects/shop/ingest-token`, {
      method: 'POST',
      headers: { Authorization: basic },
    });
    const { token } = (await created.json()) as { token: string };
    const stored = db.projects.get('shop')!.tokenHash!;
    assert.notEqual(stored, token);
    assert.ok(!stored.includes(token));
    assert.equal(stored, hashIngestToken(token));
    assert.match(stored, /^[0-9a-f]{64}$/);
  });
  assert.ok(tokenMatches(TOKEN, hashIngestToken(TOKEN)));
  assert.ok(!tokenMatches(TOKEN, null));
  assert.ok(!tokenMatches('kurz', hashIngestToken('kurz')));
});

test('Anfragen über 16 KB werden abgelehnt', async () => {
  const db = new FakeProductionDb({ tokenHash: hashIngestToken(TOKEN) });
  await withApp(db, async (url) => {
    const big = JSON.stringify({ message: 'x'.repeat(17 * 1024) });
    assert.equal((await report(url, TOKEN, big)).status, 413);
    assert.equal(db.events.length, 0);
  });
});

test('Oberhalb des Rate-Limits antwortet der Endpunkt mit 429', async () => {
  const db = new FakeProductionDb({ tokenHash: hashIngestToken(TOKEN) });
  await withApp(db, async (url) => {
    const statuses: number[] = [];
    for (let index = 0; index < 61; index += 1) statuses.push((await report(url)).status);
    assert.ok(statuses.slice(0, 60).every((status) => status === 202));
    assert.equal(statuses[60], 429);
    assert.equal(db.events[0]!.count, 60);
  });
});

test('Meldung als JSON oder Text; ohne Meldung ungültig', () => {
  assert.deepEqual(parseIngestBody('{"message":"Boom","stack":"at x","source":"node"}'), {
    source: 'ingest',
    message: 'Boom',
    stack: 'at x',
    origin: 'node',
  });
  assert.equal(parseIngestBody('Plain text error')?.message, 'Plain text error');
  assert.equal(parseIngestBody('{"stack":"at x"}'), null);
  assert.equal(parseIngestBody(''), null);
});
