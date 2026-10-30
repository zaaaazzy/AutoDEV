import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ProviderLimit } from '../../core/models.js';
import { activeLimits, limitText } from './provider-limits.js';

const limit = (overrides: Partial<ProviderLimit> = {}): ProviderLimit => ({
  provider: 'claude',
  label: 'Claude',
  status: 'limited',
  since: '2026-10-29T11:00:00.000Z',
  resetAt: '2026-10-29T19:53:00.000Z',
  paymentUrl: 'https://claude.ai/settings/usage',
  actions: { pay: true, resume: false },
  ...overrides,
});

test('Hinweis nur für Anbieter mit Limit, solange der Reset in der Zukunft liegt', () => {
  const now = new Date('2026-10-29T12:00:00.000Z');
  const providers = [limit(), limit({ provider: 'gemini', status: 'ok', resetAt: null })];
  assert.deepEqual(
    activeLimits(providers, now).map((entry) => entry.provider),
    ['claude'],
  );
  assert.deepEqual(activeLimits([limit()], new Date('2026-10-29T20:00:00.000Z')), []);
});

test('Links ohne https werden nie angezeigt', () => {
  const now = new Date('2026-10-29T12:00:00.000Z');
  assert.deepEqual(activeLimits([limit({ paymentUrl: 'javascript:alert(1)' })], now), []);
  assert.deepEqual(activeLimits([limit({ paymentUrl: 'http://claude.ai' })], now), []);
});

test('Meldung nennt Anbieter und Reset-Zeit', () => {
  assert.match(limitText(limit()), /^Limit erreicht – Agents mit Claude pausieren bis .*\d{2}:\d{2} Uhr\.$/);
  assert.equal(limitText(limit({ resetAt: null })), 'Limit erreicht – Agents mit Claude pausieren.');
});

test('Limit der Organisation: Meldung nennt den Admin', () => {
  assert.equal(
    limitText(limit({ resetAt: null, scope: 'org' })),
    'Limit erreicht – Agents mit Claude pausieren. Erhöhen kann es nur ein Admin der Organisation.',
  );
  assert.doesNotMatch(limitText(limit({ scope: 'account' })), /Admin/);
});
