export function formatHours(value: number | null | undefined): string {
  return value === null || value === undefined ? '–' : `${Number(value).toLocaleString('de-DE', { maximumFractionDigits: 1 })} h`;
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
