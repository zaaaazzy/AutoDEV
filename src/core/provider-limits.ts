import type { Pool } from 'pg';

/**
 * Nutzungslimit des Agent-Kontos (Claude-CLI): „You've hit your session limit · resets 12:40am (Europe/Zurich)“,
 * auch mit zwei Wörtern („monthly spend limit“).
 */
export const USAGE_LIMIT = /hit your (?:[\w-]+ ){1,2}limit/i;
const LIMIT_RESET =
  /resets?\s+(?:(?:on\s+)?([A-Z][a-z]{2})\s+(\d{1,2}),?\s+)?(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** Anfang des Vermerks an Aufträgen, die wegen des Nutzungslimits bis zum Reset warten (retry_after). */
export const USAGE_LIMIT_REASON = 'Unterbrochen: Nutzungslimit des Agent-Kontos erreicht';

/**
 * Nutzungslimit des Agent-Kontos erreicht: kein Fehler im Code und nichts, was eine Wiederholung in Minuten löst.
 * Liefert den Zeitpunkt, ab dem der Auftrag wieder starten darf (Reset laut Meldung plus kleine Reserve, in der
 * Zeitzone des Workers); ohne lesbare Zeit eine Stunde später. Null, wenn die Ausgabe kein Limit meldet.
 */
export function usageLimitReset(output: string, now = new Date()): Date | null {
  const tail = output.slice(-3000);
  if (!USAGE_LIMIT.test(tail)) return null;
  const match = tail.match(LIMIT_RESET);
  if (!match) return new Date(now.getTime() + 60 * 60_000);
  const [, month, day, hour, minute, meridiem] = match;
  const hours = (Number(hour) % 12) + (meridiem!.toLowerCase() === 'pm' ? 12 : 0);
  const reset = new Date(now);
  reset.setHours(hours, Number(minute ?? 0), 0, 0);
  const monthIndex = month ? MONTHS.indexOf(month.toLowerCase()) : -1;
  if (monthIndex >= 0 && day) {
    reset.setMonth(monthIndex, Number(day));
    if (reset.getTime() <= now.getTime()) reset.setFullYear(reset.getFullYear() + 1);
  } else if (reset.getTime() <= now.getTime()) {
    reset.setDate(reset.getDate() + 1);
  }
  return new Date(reset.getTime() + 3 * 60_000);
}

/**
 * Bezahlte Agent-Anbieter (CLI-Programm → Anzeige und Seite zum Verbrauch bzw. Bezahlen). Die Links stehen nur hier
 * und werden nie aus der Ausgabe einer CLI übernommen.
 */
export const AGENT_PROVIDERS = {
  claude: { label: 'Claude', paymentUrl: 'https://claude.ai/settings/usage' },
  copilot: { label: 'GitHub Copilot', paymentUrl: 'https://github.com/settings/copilot' },
  gemini: { label: 'Gemini', paymentUrl: 'https://console.cloud.google.com/billing' },
} as const satisfies Record<string, { label: string; paymentUrl: `https://${string}` }>;

export type AgentProvider = keyof typeof AGENT_PROVIDERS;

const KEY_PREFIX = 'provider_limit:';

/** Anbieter eines CLI-Befehls nach dem Programmnamen (`/usr/local/bin/claude` → claude); sonst null (z. B. Ollama). */
export function providerOfCommand(command: readonly string[] | null | undefined): AgentProvider | null {
  const program = (command?.[0] ?? '').split(/[\\/]/).pop()?.toLowerCase() ?? '';
  return Object.hasOwn(AGENT_PROVIDERS, program) ? (program as AgentProvider) : null;
}

export function isAgentProvider(value: unknown): value is AgentProvider {
  return typeof value === 'string' && Object.hasOwn(AGENT_PROVIDERS, value);
}

/** Limit des Anbieters festhalten (app_settings `provider_limit:<anbieter>`): seit wann und bis wann. */
export async function recordProviderLimit(
  pool: Pick<Pool, 'query'>,
  provider: AgentProvider,
  resetAt: Date,
  now = new Date(),
): Promise<void> {
  await pool.query(
    `INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [KEY_PREFIX + provider, JSON.stringify({ since: now.toISOString(), resetAt: resetAt.toISOString() })],
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
  if (reset) await recordProviderLimit(pool, provider, reset, now);
  else if (result.exitCode === 0) await clearProviderLimit(pool, provider);
  return reset;
}

export interface ProviderLimitStatus {
  provider: AgentProvider;
  label: string;
  status: 'ok' | 'limited';
  since: string | null;
  resetAt: string | null;
  paymentUrl: string;
}

/**
 * Status je Anbieter aus den gespeicherten Einträgen. Ein Limit gilt nur bis zum gemeldeten Reset: danach steht der
 * Anbieter wieder auf „ok“, auch wenn noch kein Lauf erfolgreich war. Unlesbare Einträge zählen als „ok“.
 */
export function providerLimitStatus(
  rows: readonly { key: string; value: string }[],
  now = new Date(),
): ProviderLimitStatus[] {
  const stored = new Map(rows.map((row) => [row.key, row.value]));
  return (Object.keys(AGENT_PROVIDERS) as AgentProvider[]).map((provider) => {
    const { label, paymentUrl } = AGENT_PROVIDERS[provider];
    let since: string | null = null;
    let resetAt: string | null = null;
    try {
      const parsed = JSON.parse(stored.get(KEY_PREFIX + provider) ?? 'null') as {
        since?: unknown;
        resetAt?: unknown;
      } | null;
      const reset = new Date(String(parsed?.resetAt));
      if (!Number.isNaN(reset.getTime()) && reset.getTime() > now.getTime()) {
        resetAt = reset.toISOString();
        const start = new Date(String(parsed?.since));
        since = Number.isNaN(start.getTime()) ? null : start.toISOString();
      }
    } catch {
      // unlesbar: wie kein Limit
    }
    return { provider, label, status: resetAt ? 'limited' : 'ok', since, resetAt, paymentUrl };
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
