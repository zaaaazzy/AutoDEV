import { visibleInterval } from './visible-interval.js';

/**
 * Ein gemeinsamer Poll für beliebig viele Abnehmer: Die erste Anmeldung lädt sofort und startet den Takt
 * (über `visibleInterval`, also nicht bei verborgenem Tab), weitere Anmeldungen hängen sich nur an.
 * Meldet sich der letzte ab, endet der Takt. `subscribe()` gibt die Abmeldefunktion zurück (mehrfach aufrufbar).
 */
export function sharedPoll(
  tick: () => void,
  ms: number,
  interval: (tick: () => void, ms: number) => () => void = visibleInterval,
  isHidden: () => boolean = () => Boolean(globalThis.document?.hidden),
): { subscribe(): () => void; readonly subscribers: number } {
  let subscribers = 0;
  let stop: (() => void) | null = null;
  return {
    get subscribers() {
      return subscribers;
    },
    subscribe() {
      subscribers++;
      if (!stop) {
        if (!isHidden()) tick();
        stop = interval(tick, ms);
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        subscribers--;
        if (!subscribers && stop) {
          stop();
          stop = null;
        }
      };
    },
  };
}
