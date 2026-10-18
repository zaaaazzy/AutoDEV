import assert from 'node:assert/strict';
import test from 'node:test';
import { FakeProductionDb } from './production-fake-db.test.js';
import {
  categoryFor,
  decideBugAction,
  fingerprint,
  isDeploySuspect,
  normalizeMessage,
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

test('Neuer Fingerabdruck ergibt einen Bug mit Quelle „Betrieb“, weitere Vorkommen erhöhen nur den Zähler', async () => {
  const db = new FakeProductionDb();
  const now = new Date();
  const first = await recordEvent(
    db.pool,
    'shop',
    { source: 'logs', message: 'ERROR db timeout 1', origin: 'api' },
    now,
  );
  assert.equal(first.action, 'create');
  for (let index = 2; index <= 10; index += 1) {
    const next = await recordEvent(db.pool, 'shop', { source: 'logs', message: `ERROR db timeout ${index}` }, now);
    assert.equal(next.action, 'count');
    assert.equal(next.bugId, first.bugId);
  }
  assert.equal(db.bugs.length, 1);
  assert.equal(db.bugs[0]!.source, 'production');
  assert.equal(db.bugs[0]!.category, 'backend');
  assert.equal(db.events[0]!.count, 10);
  assert.equal(db.bugs[0]!.severity, 'high', '10 pro Stunde');
  assert.match(db.bugs[0]!.description, /```text\nERROR db timeout 1\n```/);
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
  const first = await recordEvent(db.pool, 'shop', { source: 'logs', message: 'ERROR payment 42 failed' });
  db.bugs[0]!.status = 'fixed';
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
  await recordEvent(without.pool, 'shop', { source: 'ingest', message: 'Kaputt' });
  assert.equal(without.orders.length, 0);

  const withFix = new FakeProductionDb({ autoBugfix: true });
  const result = await recordEvent(withFix.pool, 'shop', { source: 'ingest', message: 'Kaputt' });
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
    { source: 'logs', message: 'ERROR nach Deploy' },
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
    { source: 'logs', message: 'ERROR viel später' },
    new Date('2026-10-18T11:00:00Z'),
  );
  assert.equal(db.events[1]!.deploySuspect, null);
});
