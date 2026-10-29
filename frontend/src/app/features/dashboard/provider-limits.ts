import type { ProviderLimit } from '../../core/models.js';

/**
 * Anbieter mit erreichtem Limit, die noch nicht zurückgesetzt sind. Auch zwischen zwei Abfragen gilt: nach dem
 * gemeldeten Reset verschwindet der Hinweis. Links nur mit https (sie kommen aus der festen Liste des Servers).
 */
export function activeLimits(providers: readonly ProviderLimit[], now = new Date()): ProviderLimit[] {
  return providers.filter(
    (entry) =>
      entry.status === 'limited' &&
      entry.resetAt !== null &&
      new Date(entry.resetAt).getTime() > now.getTime() &&
      entry.paymentUrl.startsWith('https://'),
  );
}

/** „Limit erreicht – Agents pausieren bis 29.10., 20:53 Uhr.“ */
export function limitText(entry: ProviderLimit): string {
  const reset = entry.resetAt ? new Date(entry.resetAt) : null;
  const until = reset
    ? reset.toLocaleString('de-CH', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
    : null;
  return until
    ? `Limit erreicht – Agents mit ${entry.label} pausieren bis ${until} Uhr.`
    : `Limit erreicht – Agents mit ${entry.label} pausieren.`;
}
