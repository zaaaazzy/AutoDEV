import type { Pool } from 'pg';

/**
 * Nutzungslimit des Agent-Kontos (Claude-CLI): „You've hit your session limit · resets 12:40am (Europe/Zurich)“,
 * auch mit mehreren Wörtern („monthly spend limit“, „org's monthly spend limit“).
 */
export const USAGE_LIMIT = /hit your (?:[\w'’-]+ ){1,3}limit/i;
/** Limit der Organisation („hit your org's … limit“): erhöhen kann es nur ein Admin der Organisation. */
const ORG_LIMIT = /hit your (?:org|organi[sz]ation)(?:'s|’s)? (?:[\w-]+ ){0,2}limit/i;
const LIMIT_RESET =
  /resets?\s+(?:(?:on\s+)?([A-Z][a-z]{2})\s+(\d{1,2}),?\s+)?(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b(?:\s*\(([\w+/-]+)\))?/i;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** Anfang des Vermerks an Aufträgen, die wegen des Nutzungslimits bis zum Reset warten (retry_after). */
export const USAGE_LIMIT_REASON = 'Unterbrochen: Nutzungslimit des Agent-Kontos erreicht';

/** Abstand der Zeitzone zu UTC im Zeitpunkt `at` (ms); null bei unbekannter Zone. */
function zoneOffset(zone: string, at: Date): number | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    }).formatToParts(at);
    const part = (type: string): number => Number(parts.find((entry) => entry.type === type)?.value);
    const wall = Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'), part('second'));
    return wall - Math.floor(at.getTime() / 1000) * 1000;
  } catch {
    return null;
  }
}

/**
 * Nutzungslimit des Agent-Kontos erreicht: kein Fehler im Code und nichts, was eine Wiederholung in Minuten löst.
 * Liefert den Zeitpunkt, ab dem der Auftrag wieder starten darf (Reset laut Meldung plus kleine Reserve). Die Uhrzeit
 * gilt in der Zeitzone der Meldung („10:20pm (UTC)“, „8:50pm (Europe/Zurich)“), ohne oder mit unbekannter Zone in der
 * des Workers; ohne lesbare Zeit eine Stunde später. Null, wenn die Ausgabe kein Limit meldet.
 */
export function usageLimitReset(output: string, now = new Date()): Date | null {
  const tail = output.slice(-3000);
  if (!USAGE_LIMIT.test(tail)) return null;
  const match = tail.match(LIMIT_RESET);
  if (!match) return new Date(now.getTime() + 60 * 60_000);
  const [, month, day, hour, minute, meridiem, zone] = match;
  const offsetAt = (at: Date): number => (zone ? zoneOffset(zone, at) : null) ?? -at.getTimezoneOffset() * 60_000;
  // Rechnen mit der Wanduhr der Zone (als UTC-Felder), danach zurück in einen echten Zeitpunkt.
  const offset = offsetAt(now);
  const wallNow = now.getTime() + offset;
  const wall = new Date(wallNow);
  wall.setUTCHours((Number(hour) % 12) + (meridiem!.toLowerCase() === 'pm' ? 12 : 0), Number(minute ?? 0), 0, 0);
  const monthIndex = month ? MONTHS.indexOf(month.toLowerCase()) : -1;
  if (monthIndex >= 0 && day) {
    wall.setUTCMonth(monthIndex, Number(day));
    if (wall.getTime() <= wallNow) wall.setUTCFullYear(wall.getUTCFullYear() + 1);
  } else if (wall.getTime() <= wallNow) {
    wall.setUTCDate(wall.getUTCDate() + 1);
  }
  // Liegt eine Sommerzeit-Umstellung dazwischen, gilt der Abstand am Reset selbst.
  const reset = wall.getTime() - offsetAt(new Date(wall.getTime() - offset));
  return new Date(reset + 3 * 60_000);
}

interface ProviderInfo {
  label: string;
  paymentUrl: `https://${string}`;
  orgPaymentUrl?: `https://${string}`;
  paymentHosts: readonly string[];
}

/**
 * Bezahlte Agent-Anbieter (CLI-Programm → Anzeige und Seite zum Verbrauch bzw. Bezahlen). Ein Link aus der Meldung
 * gilt nur mit https auf einem der `paymentHosts`; sonst die feste Seite (bei einem Limit der Organisation die der
 * Admins, falls bekannt).
 */
export const AGENT_PROVIDERS = {
  claude: {
    label: 'Claude',
    paymentUrl: 'https://claude.ai/settings/usage',
    orgPaymentUrl: 'https://claude.ai/admin-settings/usage',
    paymentHosts: ['claude.ai'],
  },
  copilot: { label: 'GitHub Copilot', paymentUrl: 'https://github.com/settings/copilot', paymentHosts: ['github.com'] },
  gemini: {
    label: 'Gemini',
    paymentUrl: 'https://console.cloud.google.com/billing',
    paymentHosts: ['console.cloud.google.com'],
  },
} as const satisfies Record<string, ProviderInfo>;

export type AgentProvider = keyof typeof AGENT_PROVIDERS;

/** Wer das Limit erhöhen kann: das eigene Konto oder nur ein Admin der Organisation. */
export type LimitScope = 'account' | 'org';

export function limitScope(output: string): LimitScope {
  return ORG_LIMIT.test(output.slice(-3000)) ? 'org' : 'account';
}

/** Link aus der Meldung, wenn er https ist und zum Anbieter gehört (ohne Query, Fragment, Port und Anmeldedaten). */
function trustedLink(provider: AgentProvider, url: string): string | null {
  try {
    const parsed = new URL(url);
    const hosts: readonly string[] = AGENT_PROVIDERS[provider].paymentHosts;
    if (parsed.protocol !== 'https:' || parsed.port || parsed.username || parsed.password) return null;
    return hosts.includes(parsed.hostname) ? `${parsed.origin}${parsed.pathname}` : null;
  } catch {
    return null;
  }
}

/**
 * Seite zum Erhöhen des Limits: Link aus der Limit-Meldung („raise it at https://claude.ai/admin-settings/usage“),
 * sonst die feste Seite je Anbieter und Fall. Fremde Hosts, http und Links vor der Meldung zählen nicht.
 */
export function paymentUrlFor(provider: AgentProvider, output: string): string {
  const tail = output.slice(-3000);
  const start = tail.search(USAGE_LIMIT);
  const links = start < 0 ? [] : (tail.slice(start).match(/https:\/\/[^\s"'<>()·]+/g) ?? []);
  for (const link of links) {
    const trusted = trustedLink(provider, link.replace(/[.,;:]+$/, ''));
    if (trusted) return trusted;
  }
  const entry: ProviderInfo = AGENT_PROVIDERS[provider];
  return (limitScope(tail) === 'org' && entry.orgPaymentUrl) || entry.paymentUrl;
}

const KEY_PREFIX = 'provider_limit:';

/** Anbieter eines CLI-Befehls nach dem Programmnamen (`/usr/local/bin/claude` → claude); sonst null (z. B. Ollama). */
export function providerOfCommand(command: readonly string[] | null | undefined): AgentProvider | null {
  const program = (command?.[0] ?? '').split(/[\\/]/).pop()?.toLowerCase() ?? '';
  return Object.hasOwn(AGENT_PROVIDERS, program) ? (program as AgentProvider) : null;
}

export function isAgentProvider(value: unknown): value is AgentProvider {
  return typeof value === 'string' && Object.hasOwn(AGENT_PROVIDERS, value);
}

/**
 * Limit des Anbieters festhalten (app_settings `provider_limit:<anbieter>`): seit wann, bis wann, wer es erhöhen kann
 * und wo (aus der Meldung, siehe paymentUrlFor).
 */
export async function recordProviderLimit(
  pool: Pick<Pool, 'query'>,
  provider: AgentProvider,
  resetAt: Date,
  now = new Date(),
  output = '',
): Promise<void> {
  const entry = {
    since: now.toISOString(),
    resetAt: resetAt.toISOString(),
    scope: limitScope(output),
    paymentUrl: paymentUrlFor(provider, output),
  };
  await pool.query(
    `INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [KEY_PREFIX + provider, JSON.stringify(entry)],
  );
}

/** Der Anbieter arbeitet wieder (erfolgreicher Lauf oder „Fortsetzen“): Limit vergessen. */
export async function clearProviderLimit(pool: Pick<Pool, 'query'>, provider: AgentProvider): Promise<void> {
  await pool.query('DELETE FROM app_settings WHERE key = $1', [KEY_PREFIX + provider]);
}

/**
 * Ergebnis eines Agent-Laufs für den Anbieterstatus: Limit-Meldung → festhalten, Erfolg → zurücksetzen. Liefert den
 * Reset-Zeitpunkt, falls die Ausgabe ein Limit meldet. Läufe ohne bekannten Anbieter (lokales Modell) ändern nichts.
 */
export async function noteProviderOutcome(
  pool: Pick<Pool, 'query'>,
  command: readonly string[] | null | undefined,
  result: { exitCode: number; output: string },
  now = new Date(),
): Promise<Date | null> {
  const reset = result.exitCode !== 0 ? usageLimitReset(result.output, now) : null;
  const provider = providerOfCommand(command);
  if (!provider) return reset;
  if (reset) await recordProviderLimit(pool, provider, reset, now, result.output);
  else if (result.exitCode === 0) await clearProviderLimit(pool, provider);
  return reset;
}

export interface ProviderLimitStatus {
  provider: AgentProvider;
  label: string;
  status: 'ok' | 'limited';
  since: string | null;
  resetAt: string | null;
  scope: LimitScope;
  paymentUrl: string;
}

/**
 * Status je Anbieter aus den gespeicherten Einträgen. Ein Limit gilt nur bis zum gemeldeten Reset: danach steht der
 * Anbieter wieder auf „ok“, auch wenn noch kein Lauf erfolgreich war. Unlesbare Einträge zählen als „ok“; ein
 * gespeicherter Link wird erneut geprüft (sonst die feste Seite).
 */
export function providerLimitStatus(
  rows: readonly { key: string; value: string }[],
  now = new Date(),
): ProviderLimitStatus[] {
  const stored = new Map(rows.map((row) => [row.key, row.value]));
  return (Object.keys(AGENT_PROVIDERS) as AgentProvider[]).map((provider) => {
    const { label } = AGENT_PROVIDERS[provider];
    let paymentUrl: string = AGENT_PROVIDERS[provider].paymentUrl;
    let since: string | null = null;
    let resetAt: string | null = null;
    let scope: LimitScope = 'account';
    try {
      const parsed = JSON.parse(stored.get(KEY_PREFIX + provider) ?? 'null') as {
        since?: unknown;
        resetAt?: unknown;
        scope?: unknown;
        paymentUrl?: unknown;
      } | null;
      const reset = new Date(String(parsed?.resetAt));
      if (!Number.isNaN(reset.getTime()) && reset.getTime() > now.getTime()) {
        resetAt = reset.toISOString();
        const start = new Date(String(parsed?.since));
        since = Number.isNaN(start.getTime()) ? null : start.toISOString();
        if (parsed?.scope === 'org') scope = 'org';
        if (typeof parsed?.paymentUrl === 'string') paymentUrl = trustedLink(provider, parsed.paymentUrl) ?? paymentUrl;
      }
    } catch {
      // unlesbar: wie kein Limit
    }
    return { provider, label, status: resetAt ? 'limited' : 'ok', since, resetAt, scope, paymentUrl };
  });
}

export async function loadProviderLimits(pool: Pick<Pool, 'query'>, now = new Date()): Promise<ProviderLimitStatus[]> {
  const { rows } = await pool.query<{ key: string; value: string }>(
    'SELECT key, value FROM app_settings WHERE key LIKE $1',
    [`${KEY_PREFIX}%`],
  );
  return providerLimitStatus(rows, now);
}

/**
 * „Limit erhöht – fortsetzen“: Limit des Anbieters vergessen und Aufträge, die nur auf den Reset warten, sofort wieder
 * freigeben (nur in den erlaubten Projekten; null = alle). Liefert die Zahl der freigegebenen Aufträge.
 */
export async function resumeAfterProviderLimit(
  pool: Pick<Pool, 'query'>,
  provider: AgentProvider,
  projects: readonly string[] | null,
): Promise<number> {
  await clearProviderLimit(pool, provider);
  const result = await pool.query(
    `UPDATE development_items SET retry_after = NULL, updated_at = NOW()
      WHERE retry_after > NOW() AND failure LIKE $1 AND ($2::text[] IS NULL OR project_slug = ANY($2))`,
    [`${USAGE_LIMIT_REASON}%`, projects],
  );
  return result.rowCount ?? 0;
}
