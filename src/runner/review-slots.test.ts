import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reviewDatabase, reviewPort, reviewUrl } from './review-slots.js';
import { orderOf, parseSprintLog } from './sprint-commits.js';

test('Review-Container: Port und Adresse je Nummer', () => {
  assert.equal(reviewPort(1), 4201);
  assert.equal(reviewUrl(3), 'http://localhost:4203');
});

test('Datenbank-Kopie je Container, aus Docker über host.docker.internal erreichbar', () => {
  const copy = reviewDatabase('postgresql://mainty:geheim@127.0.0.1:5432/mainty', 2);
  assert.equal(copy?.source.toString(), 'postgresql://mainty:geheim@host.docker.internal:5432/mainty');
  assert.equal(copy?.target.toString(), 'postgresql://mainty:geheim@host.docker.internal:5432/mainty_review_2');
  assert.equal(reviewDatabase('postgresql://db.example:5432/app', 1)?.target.hostname, 'db.example');
  assert.equal(reviewDatabase('kein url', 1), null);
});

test('Sprint-Stände: Git-Log lesen und Auftrag aus dem Merge erkennen', () => {
  const hash = 'a'.repeat(40);
  const log = `${hash}\x1fMerge auftrag/1a2b3c4d-liste: Liste\x1f2026-10-19T20:00:00+02:00\x1e\nkaputt\x1e`;
  assert.deepEqual(parseSprintLog(log), [
    { hash, subject: 'Merge auftrag/1a2b3c4d-liste: Liste', date: '2026-10-19T20:00:00+02:00' },
  ]);
  const items = [{ id: '1a2b3c4d-0000-0000-0000-000000000000' }, { id: 'ffffffff-0000-0000-0000-000000000000' }];
  assert.equal(orderOf('Merge auftrag/1a2b3c4d-liste: Liste', items), items[0]!.id);
  assert.equal(orderOf('feat: ohne Auftrag', items), null);
});
