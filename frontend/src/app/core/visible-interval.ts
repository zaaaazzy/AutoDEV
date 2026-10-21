/** Minimal benötigte Teile von `document`; in Tests durch ein `EventTarget` ersetzbar. */
export interface VisibilitySource {
  readonly hidden: boolean;
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
}

/**
 * Wie `setInterval`, pausiert aber, solange der Tab verborgen ist. Wird der Tab wieder sichtbar, läuft `tick`
 * sofort einmal und danach wieder im Takt. Gibt eine Funktion zurück, die Timer und Listener entfernt.
 */
export function visibleInterval(
  tick: () => void,
  ms: number,
  source: VisibilitySource | undefined = globalThis.document,
): () => void {
  let timer: ReturnType<typeof setInterval> | null = null;
  const start = (): void => {
    if (timer === null) timer = globalThis.setInterval(tick, ms);
  };
  const stop = (): void => {
    if (timer !== null) globalThis.clearInterval(timer);
    timer = null;
  };
  const onVisibilityChange = (): void => {
    if (source?.hidden) {
      stop();
    } else if (timer === null) {
      tick();
      start();
    }
  };
  if (!source?.hidden) start();
  source?.addEventListener('visibilitychange', onVisibilityChange);
  return () => {
    stop();
    source?.removeEventListener('visibilitychange', onVisibilityChange);
  };
}
