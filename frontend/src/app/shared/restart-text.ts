/** Texte der Neustart-Statusleiste (ohne Angular, damit testbar). */

/** Hinweis aus der ersten Log-Zeile, ob der neueste Stand von GitHub geholt wurde (pullBranch im Worker). */
export function pullNote(log: string | null | undefined): string {
  const first = (log ?? '').split('\n')[0]?.trim() ?? '';
  return /^(Neuester Stand|Stand von origin|Kein Remote|GitHub nicht erreichbar|Lokaler Stand weicht)/.test(first)
    ? first
    : '';
}

export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${String(seconds % 60).padStart(2, '0')} s`;
}
