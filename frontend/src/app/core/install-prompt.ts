import { signal } from '@angular/core';

export interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
}

/**
 * Angebot des Browsers, die App zu installieren. Das Ereignis kommt kurz nach dem Laden der Seite – der Listener
 * muss deshalb beim Start hängen, nicht erst beim Öffnen der Einstellungen.
 */
export const installPrompt = signal<InstallPromptEvent | null>(null);

export function listenForInstallPrompt(): void {
  globalThis.addEventListener?.('beforeinstallprompt', (event) => {
    event.preventDefault();
    installPrompt.set(event as InstallPromptEvent);
  });
  globalThis.addEventListener?.('appinstalled', () => installPrompt.set(null));
}
