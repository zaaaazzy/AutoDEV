import assert from 'node:assert/strict';
import test from 'node:test';
import { FakeProductionDb } from './production-fake-db.test.js';
import {
  BUG_THRESHOLD,
  BUG_WINDOW_MS,
  categoryFor,
  decideBugAction,
  fingerprint,
  isDeploySuspect,
  normalizeMessage,
  reachesBugThreshold,
  recordEvent,
  sampleOf,
  severityFor,
} from './production-events.js';

test('Fingerabdruck: Meldungen, die sich nur in Zahlen, IDs oder Zeitstempeln unterscheiden, fallen zusammen', () => {
  const stack = (line: number) =>
    `    at loadUser (/app/src/users.js:${line}:7)\n    at next (/app/node_modules/x.js:1:1)`;
  const a = fingerprint(
    '2026-10-18T10:00:01.123Z Order 4711 failed for user 3f2a9c1e-1b2c-4d5e-8f90-123456789abc (req 5f8d0a3b2c1e)',
    stack(12),
  );
  const b = fingerprint(
    '2026-10-19 08:15:59 Order 815 failed for user 0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d (req 64b7ee9a10ff)',
    stack(13),
  );
  assert.equal(a, b);
  assert.notEqual(a, fingerprint('Order 4711 timed out', stack(12)), 'andere Meldung');
  assert.notEqual(a, fingerprint(`Order 4711 failed for user x`, '    at saveUser (/app/src/users.js:1:1)'));
  assert.equal(normalizeMessage('Took 512 ms at 12:01:02'), 'took <n> ms at <ts>');
  // E-Mail-Adressen werden vor dem Fingerabdruck maskiert: andere Person, gleicher Fehler.
  assert.equal(fingerprint('No account for anna@example.ch'), fingerprint('No account for bob@example.org'));
});

test('Beispiel wird maskiert und gekürzt gespeichert', () => {
  const sample = sampleOf({ source: 'ingest', message: `Login für max@example.ch ${'x'.repeat(5000)}` });
  assert.ok(!sample.includes('max@example.ch'));
  assert.ok(sample.length <= 2000);
});

test('Schwere: ab 50 pro Stunde oder bei Ausfall kritisch, sonst nach Häufigkeit', () => {
  assert.equal(severityFor(50), 'critical');
  assert.equal(severityFor(49), 'high');
  assert.equal(severityFor(10), 'high');
  assert.equal(severityFor(3), 'medium');
  assert.equal(severityFor(1), 'low');
  assert.equal(severityFor(1, true), 'critical');
});

test('Bekannt und offen zählt, bekannt und behoben öffnet als Regression, unbekannt legt an', () => {
  assert.equal(decideBugAction(null), 'create');
  assert.equal(decideBugAction('open'), 'count');
  assert.equal(decideBugAction('in_progress'), 'count');
  assert.equal(decideBugAction('wontfix'), 'count');
  assert.equal(decideBugAction('fixed'), 'reopen');
});

test('Kategorie aus Dienst bzw. Pfad', () => {
  assert.equal(categoryFor({ source: 'health', message: 'x' }), 'infrastructure');
  assert.equal(categoryFor({ source: 'logs', message: 'x', origin: 'postgres' }), 'infrastructure');
  assert.equal(categoryFor({ source: 'logs', message: 'x', origin: 'web' }), 'frontend');
  assert.equal(categoryFor({ source: 'ingest', message: 'x', origin: 'browser /kasse' }), 'frontend');
  assert.equal(categoryFor({ source: 'logs', message: 'x', origin: 'api' }), 'backend');
});

test('Schwelle: neue Bugs ab drei Vorkommen in 24 Stunden, kritische sofort', () => {
  assert.equal(BUG_THRESHOLD, 3);
  assert.equal(BUG_WINDOW_MS, 24 * 3600_000);
  assert.ok(!reachesBugThreshold(2));
  assert.ok(reachesBugThreshold(3));
  assert.ok(reachesBugThreshold(1, true));
});

test('Unter der Schwelle wird nur gezählt: zwei Vorkommen in 24 Stunden ergeben keinen Bug', async () => {
  const db = new FakeProductionDb();
  const now = new Date('2026-10-20T12:00:00Z');
  const first = await recordEvent(db.pool, 'shop', { source: 'logs', message: 'ERROR db timeout 1' }, now);
  const second = await recordEvent(
    db.pool,
    'shop',
    { source: 'logs', message: 'ERROR db timeout 2' },
    new Date('2026-10-21T09:00:00Z'),
  );
  for (const result of [first, second]) {
    assert.equal(result.action, 'count');
    assert.equal(result.bugId, null);
  }
  assert.equal(db.bugs.length, 0);
  assert.equal(db.events.length, 1);
  assert.equal(db.events[0]!.bugId, null);
  assert.equal(db.events[0]!.count, 2);
});

test('Vorkommen ausserhalb des 24-Stunden-Fensters zählen nicht zur Schwelle', async () => {
  const db = new FakeProductionDb();
  await recordEvent(db.pool, 'shop', { source: 'ingest', message: 'Alt', count: 2 }, new Date('2026-10-18T08:00:00Z'));
  const later = await recordEvent(
    db.pool,
    'shop',
    { source: 'ingest', message: 'Alt' },
    new Date('2026-10-20T08:00:00Z'),
  );
  assert.equal(later.bugId, null);
  assert.equal(db.bugs.length, 0);
  assert.equal(db.events[0]!.count, 3);
});

test('Ab drei Vorkommen entsteht genau ein Bug mit Quelle „Betrieb“, weitere erhöhen nur den Zähler', async () => {
  const db = new FakeProductionDb();
  const now = new Date();
  for (let index = 1; index <= 2; index += 1) {
    await recordEvent(db.pool, 'shop', { source: 'logs', message: `ERROR db timeout ${index}`, origin: 'api' }, now);
  }
  const third = await recordEvent(
    db.pool,
    'shop',
    { source: 'logs', message: 'ERROR db timeout 3', origin: 'api' },
    now,
  );
  assert.equal(third.action, 'create');
  assert.ok(third.bugId);
  assert.equal(db.events[0]!.bugId, third.bugId);
  for (let index = 4; index <= 10; index += 1) {
    const next = await recordEvent(db.pool, 'shop', { source: 'logs', message: `ERROR db timeout ${index}` }, now);
    assert.equal(next.action, 'count');
    assert.equal(next.bugId, third.bugId);
  }
  assert.equal(db.bugs.length, 1);
  assert.equal(db.bugs[0]!.source, 'production');
  assert.equal(db.bugs[0]!.status, 'open');
  assert.equal(db.bugs[0]!.category, 'backend');
  assert.equal(db.events[0]!.count, 10);
  assert.equal(db.bugs[0]!.severity, 'high', '10 pro Stunde');
  assert.match(db.bugs[0]!.description, /```text\nERROR db timeout 3\n```/);
});

test('Ein gebündeltes Ereignis mit count ≥ 3 erreicht die Schwelle sofort', async () => {
  const db = new FakeProductionDb();
  const result = await recordEvent(db.pool, 'shop', { source: 'logs', message: 'ERROR Bündel', count: 3 });
  assert.equal(result.action, 'create');
  assert.equal(db.bugs.length, 1);
});

test('Kritisches Ereignis umgeht die Schwelle und wird beim ersten Vorkommen Bug', async () => {
  const db = new FakeProductionDb();
  const result = await recordEvent(db.pool, 'shop', { source: 'ingest', message: 'Ausfall', critical: true });
  assert.equal(result.action, 'create');
  assert.ok(result.bugId);
  assert.equal(db.bugs.length, 1);
  assert.equal(db.bugs[0]!.severity, 'critical');
  assert.equal(db.bugs[0]!.status, 'open');
});

test('Ab 50 Ereignissen pro Stunde wird der Bug kritisch', async () => {
  const db = new FakeProductionDb();
  const now = new Date();
  await recordEvent(db.pool, 'shop', { source: 'ingest', message: 'Boom', count: 49 }, now);
  assert.equal(db.bugs[0]!.severity, 'high');
  const result = await recordEvent(db.pool, 'shop', { source: 'ingest', message: 'Boom' }, now);
  assert.equal(result.severity, 'critical');
  assert.equal(db.bugs[0]!.severity, 'critical');
});

test('Behobener Bug wird als Regression wieder geöffnet, es entsteht kein neuer', async () => {
  const db = new FakeProductionDb();
  const first = await recordEvent(db.pool, 'shop', { source: 'logs', message: 'ERROR payment 42 failed', count: 3 });
  db.bugs[0]!.status = 'fixed';
  // Ein einzelnes Wiederauftreten genügt: Regressionen umgehen die Schwelle.
  const again = await recordEvent(db.pool, 'shop', { source: 'logs', message: 'ERROR payment 43 failed' });
  assert.equal(again.action, 'reopen');
  assert.equal(again.bugId, first.bugId);
  assert.equal(db.bugs.length, 1);
  assert.equal(db.bugs[0]!.status, 'open');
  assert.ok(db.bugs[0]!.regressedAt);
  assert.match(db.bugs[0]!.fixNotes, /Regression/);
});

test('Mit Auto-Bugfix entsteht für einen neuen Betriebs-Bug ein Bug-Auftrag, ohne nicht', async () => {
  const without = new FakeProductionDb({ autoBugfix: false });
  await recordEvent(without.pool, 'shop', { source: 'ingest', message: 'Kaputt', count: 3 });
  assert.equal(without.orders.length, 0);

  const withFix = new FakeProductionDb({ autoBugfix: true });
  const result = await recordEvent(withFix.pool, 'shop', { source: 'ingest', message: 'Kaputt', count: 3 });
  assert.equal(withFix.orders.length, 1);
  assert.equal(withFix.orders[0]!.bugId, result.bugId);
  assert.equal(withFix.orders[0]!.autoRun, true);
  assert.match(withFix.orders[0]!.description ?? '', /im Betrieb erfasst/);
  // Weitere Vorkommen legen keinen zweiten Auftrag an.
  await recordEvent(withFix.pool, 'shop', { source: 'ingest', message: 'Kaputt' });
  assert.equal(withFix.orders.length, 1);
});

test('Ereignisse bis 30 min nach einem Deploy verlinken dessen Aufträge und Sprints, spätere nicht', async () => {
  const deployedAt = new Date('2026-10-18T10:00:00Z');
  assert.ok(isDeploySuspect(deployedAt, new Date('2026-10-18T10:30:00Z')));
  assert.ok(!isDeploySuspect(deployedAt, new Date('2026-10-18T10:30:01Z')));
  assert.ok(!isDeploySuspect(deployedAt, new Date('2026-10-18T09:59:00Z')));

  const db = new FakeProductionDb();
  db.sprints.set('sprint-1', 'Sprint 7');
  db.orders.push({
    id: 'order-1',
    project: 'shop',
    title: 'Kasse umbauen',
    status: 'done',
    bugId: null,
    autoRun: false,
    sprintId: 'sprint-1',
  });
  db.deploys.push({ project: 'shop', deployedAt, orderIds: ['order-1'] });
  await recordEvent(
    db.pool,
    'shop',
    { source: 'logs', message: 'ERROR nach Deploy', count: 3 },
    new Date('2026-10-18T10:12:00Z'),
  );
  assert.deepEqual(db.events[0]!.deploySuspect, {
    deployedAt: deployedAt.toISOString(),
    orders: [{ id: 'order-1', title: 'Kasse umbauen' }],
    sprints: [{ id: 'sprint-1', name: 'Sprint 7' }],
  });
  await recordEvent(
    db.pool,
    'shop',
    { source: 'logs', message: 'ERROR viel später', count: 3 },
    new Date('2026-10-18T11:00:00Z'),
  );
  assert.equal(db.events[1]!.deploySuspect, null);
});
