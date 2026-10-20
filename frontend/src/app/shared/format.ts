export function formatHours(value: number | null | undefined): string {
  return value === null || value === undefined
    ? '–'
    : `${Number(value).toLocaleString('de-DE', { maximumFractionDigits: 1 })} h`;
}

export function formatNumber(value: number | null | undefined): string {
  return Number(value ?? 0).toLocaleString('de-DE');
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '–';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '–' : date.toLocaleString('de-DE');
}

export function formatDuration(value: number | null | undefined): string {
  const milliseconds = Number(value ?? 0);
  if (milliseconds >= 60_000) return `${(milliseconds / 60_000).toFixed(1)} min`;
  if (milliseconds >= 1000) return `${(milliseconds / 1000).toFixed(1)} s`;
  return `${milliseconds} ms`;
}

/** ISO-Zeitstempel als `TT.MM.JJJJ`. */
export function formatIsoDate(value: string): string {
  return value.slice(0, 10).split('-').reverse().join('.');
}

export function shortText(text: string | null | undefined, limit = 200): string {
  const value = (text ?? '').trim();
  return value.length > limit ? `${value.slice(0, limit).trimEnd()}...` : value;
}

/** Referenzpreis für die Kostenschätzung (USD je 1 Mio. Tokens); lokale Modelle verursachen real keine Kosten. */
export const USD_PER_MILLION_TOKENS = 5;

export function tokenCostUsd(tokens: number | null | undefined): number | null {
  return tokens === null || tokens === undefined ? null : (tokens / 1_000_000) * USD_PER_MILLION_TOKENS;
}

export function formatTokens(value: number | null | undefined): string {
  return value === null || value === undefined ? '–' : `${Number(value).toLocaleString('de-DE')} Tokens`;
}

/** Betrag in der Anzeigewährung des Budgets (USD oder CHF zum festen Kurs aus den Einstellungen). */
export function formatMoney(
  usd: number | null | undefined,
  display: { currency: 'USD' | 'CHF'; chfPerUsd: number } | null | undefined,
): string {
  if (usd === null || usd === undefined) return '–';
  const chf = display?.currency === 'CHF';
  const value = chf ? usd * display.chfPerUsd : usd;
  return `${value.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${chf ? 'CHF' : 'USD'}`;
}

export function formatUsd(value: number | null | undefined): string {
  return value === null || value === undefined
    ? '–'
    : `≈ ${value.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} $`;
}
