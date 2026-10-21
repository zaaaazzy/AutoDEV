import { signal } from '@angular/core';

export interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
}

/**
 * Angebot des Browsers, die App zu installieren. Das Ereignis kommt kurz nach dem Laden der Seite – der Listener
 * muss deshalb beim Start hängen, nicht erst beim Öffnen der Einstellungen.
 */
export const installPrompt = signal<InstallPromptEvent | null>(null);

let stopListening: (() => void) | null = null;

/** Hängt die Listener genau einmal an; mehrfacher Aufruf liefert dieselbe Aufräumfunktion. */
export function listenForInstallPrompt(target: EventTarget | undefined = globalThis): () => void {
  if (stopListening) return stopListening;
  const onPrompt = (event: Event): void => {
    event.preventDefault();
    installPrompt.set(event as InstallPromptEvent);
  };
  const onInstalled = (): void => installPrompt.set(null);
  target?.addEventListener?.('beforeinstallprompt', onPrompt);
  target?.addEventListener?.('appinstalled', onInstalled);
  stopListening = () => {
    target?.removeEventListener?.('beforeinstallprompt', onPrompt);
    target?.removeEventListener?.('appinstalled', onInstalled);
    stopListening = null;
  };
  return stopListening;
}
