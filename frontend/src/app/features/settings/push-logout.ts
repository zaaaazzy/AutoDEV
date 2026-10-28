/** Push-Abo des Geräts, soweit der Logout es braucht. */
export interface DeviceSubscription {
  endpoint: string;
  unsubscribe(): Promise<boolean>;
}

export interface LogoutSteps {
  /** Abo dieses Browsers (oder null ohne Service Worker / Abo). */
  subscription(): Promise<DeviceSubscription | null>;
  post(url: string, body?: unknown): Promise<unknown>;
}

/**
 * Abmelden samt Push-Abo: solange die Sitzung gilt, Abo am Server und im Browser abmelden, dann ausloggen. Fehler
 * beim Abo blockieren den Logout nie; der Endpunkt geht zusätzlich mit, damit der Server das Abo trotzdem löscht.
 */
export async function logoutWithPush(steps: LogoutSteps): Promise<void> {
  let endpoint: string | undefined;
  try {
    const subscription = await steps.subscription();
    if (subscription) {
      endpoint = subscription.endpoint;
      await steps.post('/api/push/unsubscribe', { endpoint }).catch(() => undefined);
      await subscription.unsubscribe();
    }
  } catch {
    // Browser-Teil fehlgeschlagen – trotzdem abmelden.
  }
  await steps.post('/api/logout', endpoint ? { endpoint } : {});
}

/** Abo des Browsers ohne auf `serviceWorker.ready` zu warten (hängt ohne registrierten Service Worker). */
export async function browserSubscription(): Promise<DeviceSubscription | null> {
  if (!('serviceWorker' in navigator)) return null;
  const registration = await navigator.serviceWorker.getRegistration();
  return (await registration?.pushManager.getSubscription()) ?? null;
}
