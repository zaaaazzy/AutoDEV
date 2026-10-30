import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AGENT_PROVIDERS,
  limitScope,
  loadProviderLimits,
  noteProviderOutcome,
  paymentUrlFor,
  providerLimitStatus,
  providerOfCommand,
  resumeAfterProviderLimit,
  USAGE_LIMIT_REASON,
} from './provider-limits.js';
import { usageLimitReset } from '../runner/autofix.js';
import { providerLimitViews } from '../api/provider-limits.js';
import type { Principal } from '../api/roles.js';
import type { Pool } from 'pg';

const LIMIT =
  "You've hit your monthly spend limit · raise it at https://evil.example/pay · your session limit resets 8:50pm (Europe/Zurich)";

/** app_settings im Speicher: INSERT … ON CONFLICT, DELETE und SELECT … LIKE; UPDATE der Aufträge wird nur notiert. */
function fakePool() {
  const settings = new Map<string, string>();
  const updates: unknown[][] = [];
  const pool = {
    async query(sql: string, values: unknown[] = []) {
      if (sql.startsWith('INSERT INTO app_settings')) settings.set(values[0] as string, values[1] as string);
      else if (sql.startsWith('DELETE FROM app_settings')) settings.delete(values[0] as string);
      else if (sql.startsWith('SELECT key, value FROM app_settings')) {
        const prefix = String(values[0]).replace(/%$/, '');
        return {
          rows: [...settings].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value })),
        };
      } else if (sql.includes('UPDATE development_items')) {
        updates.push(values);
        return { rows: [], rowCount: 3 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  return Object.assign(pool as unknown as Pick<Pool, 'query'>, { settings, updates });
}

test('Anbieter kommt aus dem Programmnamen des Befehls, nicht aus der Ausgabe', () => {
  assert.equal(providerOfCommand(['/usr/local/bin/claude', '-p', '{prompt}']), 'claude');
  assert.equal(providerOfCommand(['gemini', '-m', 'gemini-2.5-pro']), 'gemini');
  assert.equal(providerOfCommand(['C:\\tools\\copilot.cmd']), null);
  assert.equal(providerOfCommand(['copilot']), 'copilot');
  assert.equal(providerOfCommand(['ollama']), null);
  assert.equal(providerOfCommand(null), null);
  assert.equal(providerOfCommand(['__proto__']), null);
});

test('Die Limit-Erkennung bleibt dieselbe (autofix exportiert sie weiter)', () => {
  const now = new Date('2026-10-29T12:00:00Z');
  assert.equal(usageLimitReset(LIMIT, now)?.toISOString(), '2026-10-29T19:53:00.000Z');
});

const ORG_LIMIT =
  "You've hit your org's monthly spend limit · ask your admin to raise it at https://claude.ai/admin-settings/usage · your session limit resets 10:20pm (UTC)";
const OWN_LIMIT =
  "You've hit your monthly spend limit · raise it at https://claude.ai/settings/usage?from=cc_cli_limit_message · your session limit resets 8:50pm (Europe/Zurich)";

test('Beide Meldungsvarianten: Reset in der Zeitzone der Meldung, nicht in der des Workers', () => {
  const now = new Date('2026-10-30T12:00:00Z');
  assert.equal(usageLimitReset(ORG_LIMIT, now)?.toISOString(), '2026-10-30T22:23:00.000Z', '22:20 UTC + Reserve');
  assert.equal(usageLimitReset(OWN_LIMIT, now)?.toISOString(), '2026-10-30T19:53:00.000Z', '20:50 MEZ + Reserve');
  // Unbekannte Zone: Uhrzeit wie bisher in der Zone des Workers (kein Absturz).
  const unknown = usageLimitReset("You've hit your session limit · resets 8:50pm (Mars/Olympus)", now);
  const local = new Date(now);
  local.setHours(20, 53, 0, 0);
  if (local.getTime() <= now.getTime()) local.setDate(local.getDate() + 1);
  assert.equal(unknown?.toISOString(), local.toISOString());
});

test('Reset über die Umstellung auf Winterzeit: es gilt der Abstand am Reset', () => {
  // 24.10. 22:00 MESZ; 3 Uhr am 25.10. ist schon MEZ (+1) → 02:00 UTC.
  const now = new Date('2026-10-24T20:00:00Z');
  const reset = usageLimitReset("You've hit your session limit · resets 3am (Europe/Zurich)", now);
  assert.equal(reset?.toISOString(), '2026-10-25T02:03:00.000Z');
});

test('Zahlungslink je Fall: Admin-Seite beim Limit der Organisation, eigene Seite sonst, nur vom Anbieter', () => {
  assert.equal(limitScope(ORG_LIMIT), 'org');
  assert.equal(limitScope(OWN_LIMIT), 'account');
  assert.equal(paymentUrlFor('claude', ORG_LIMIT), 'https://claude.ai/admin-settings/usage');
  assert.equal(paymentUrlFor('claude', OWN_LIMIT), 'https://claude.ai/settings/usage', 'ohne Query');
  // Fremder Host, http, Port oder ein Link vor der Meldung: feste Seite je Fall.
  assert.equal(paymentUrlFor('claude', LIMIT), 'https://claude.ai/settings/usage');
  assert.equal(
    paymentUrlFor('claude', ORG_LIMIT.replace('https://claude.ai', 'http://claude.ai')),
    'https://claude.ai/admin-settings/usage',
  );
  assert.equal(
    paymentUrlFor('claude', OWN_LIMIT.replace('https://claude.ai/settings', 'https://claude.ai:8443/x')),
    'https://claude.ai/settings/usage',
  );
  assert.equal(
    paymentUrlFor('claude', "siehe https://claude.ai/evil\nYou've hit your usage limit."),
    'https://claude.ai/settings/usage',
  );
  assert.equal(paymentUrlFor('claude', "You've hit your org's usage limit."), 'https://claude.ai/admin-settings/usage');
  assert.equal(paymentUrlFor('gemini', ORG_LIMIT), 'https://console.cloud.google.com/billing');
});

test('Limit der Organisation wird mit Admin-Link festgehalten; ein manipulierter Link fällt auf die feste Seite', async () => {
  const pool = fakePool();
  const now = new Date('2026-10-30T12:00:00Z');
  await noteProviderOutcome(pool, ['claude'], { exitCode: 1, output: ORG_LIMIT }, now);
  const claude = (await loadProviderLimits(pool, now)).find((entry) => entry.provider === 'claude');
  assert.equal(claude?.status, 'limited');
  assert.equal(claude?.scope, 'org');
  assert.equal(claude?.paymentUrl, 'https://claude.ai/admin-settings/usage');
  assert.equal(claude?.resetAt, '2026-10-30T22:23:00.000Z');
  const tampered = providerLimitStatus(
    [
      {
        key: 'provider_limit:claude',
        value: JSON.stringify({ resetAt: '2999-01-01T00:00:00Z', scope: 'x', paymentUrl: 'https://evil.example/pay' }),
      },
    ],
    now,
  ).find((entry) => entry.provider === 'claude');
  assert.equal(tampered?.paymentUrl, 'https://claude.ai/settings/usage');
  assert.equal(tampered?.scope, 'account');
});

test('Limit-Meldung wird je Anbieter festgehalten, mit fester https-Zahlungsseite statt fremdem Link', async () => {
  const pool = fakePool();
  const now = new Date('2026-10-29T12:00:00Z');
  const reset = await noteProviderOutcome(pool, ['claude', '-p'], { exitCode: 1, output: LIMIT }, now);
  assert.ok(reset);
  const [claude] = (await loadProviderLimits(pool, now)).filter((entry) => entry.provider === 'claude');
  assert.equal(claude?.status, 'limited');
  assert.equal(claude?.resetAt, reset.toISOString());
  assert.equal(claude?.since, now.toISOString());
  assert.equal(claude?.paymentUrl, 'https://claude.ai/settings/usage');
  for (const provider of Object.values(AGENT_PROVIDERS)) assert.match(provider.paymentUrl, /^https:\/\//);
});

test('Nach dem Reset steht der Anbieter wieder auf ok, ein erfolgreicher Lauf löscht den Eintrag', async () => {
  const pool = fakePool();
  const now = new Date('2026-10-29T12:00:00');
  const reset = (await noteProviderOutcome(pool, ['claude'], { exitCode: 1, output: LIMIT }, now))!;
  const later = new Date(reset.getTime() + 1000);
  assert.equal((await loadProviderLimits(pool, later)).find((entry) => entry.provider === 'claude')?.status, 'ok');
  await noteProviderOutcome(pool, ['claude'], { exitCode: 0, output: 'fertig' }, now);
  assert.equal(pool.settings.size, 0);
});

test('Andere Fehler, lokale Modelle und unbekannte Programme ändern den Status nicht', async () => {
  const pool = fakePool();
  await noteProviderOutcome(pool, ['claude'], { exitCode: 1, output: 'AssertionError: 2 !== 3' });
  await noteProviderOutcome(pool, null, { exitCode: 1, output: LIMIT });
  await noteProviderOutcome(pool, ['my-wrapper'], { exitCode: 1, output: LIMIT });
  assert.equal(pool.settings.size, 0);
});

test('Unlesbare oder abgelaufene Einträge gelten als ok', () => {
  const status = providerLimitStatus([
    { key: 'provider_limit:claude', value: 'kein json' },
    { key: 'provider_limit:gemini', value: JSON.stringify({ resetAt: '2020-01-01T00:00:00Z' }) },
  ]);
  assert.deepEqual(
    status.map((entry) => entry.status),
    ['ok', 'ok', 'ok'],
  );
});

test('Fortsetzen löscht das Limit und gibt nur Aufträge frei, die auf das Nutzungslimit warten', async () => {
  const pool = fakePool();
  await noteProviderOutcome(pool, ['claude'], { exitCode: 1, output: LIMIT });
  assert.equal(await resumeAfterProviderLimit(pool, 'claude', null), 3);
  assert.equal(pool.settings.size, 0);
  assert.deepEqual(pool.updates, [[`${USAGE_LIMIT_REASON}%`, null]]);
});

test('Aktionen: Link nur bei Limit, Fortsetzen nur mit „Ausführen“ und Zugriff auf alle Projekte', () => {
  const limits = providerLimitStatus([
    { key: 'provider_limit:claude', value: JSON.stringify({ since: null, resetAt: '2999-01-01T00:00:00Z' }) },
  ]);
  const runner: Principal = { id: 'u1', username: 'r', displayName: 'R', roles: ['run'] };
  const viewer: Principal = { id: 'u2', username: 'v', displayName: 'V', roles: [] };
  const claude = (views: ReturnType<typeof providerLimitViews>) => views.find((entry) => entry.provider === 'claude');
  assert.deepEqual(claude(providerLimitViews(limits, runner, null))?.actions, { pay: true, resume: true });
  assert.deepEqual(claude(providerLimitViews(limits, viewer, null))?.actions, { pay: true, resume: false });
  assert.deepEqual(claude(providerLimitViews(limits, runner, new Set(['a'])))?.actions, { pay: true, resume: false });
  const gemini = providerLimitViews(limits, runner, null).find((entry) => entry.provider === 'gemini');
  assert.deepEqual(gemini?.actions, { pay: false, resume: false });
});
