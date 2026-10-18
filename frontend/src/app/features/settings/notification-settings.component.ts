import { Component, inject, signal } from '@angular/core';
import { ApiService } from '../../core/api.service.js';
import { errorMessage } from '../../core/errors.js';

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
}

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const padded = (value + '='.repeat((4 - (value.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** Installation als App und Push-Nachrichten auf diesem Gerät. */
@Component({
  selector: 'app-notification-settings',
  standalone: true,
  templateUrl: './notification-settings.component.html',
})
export class NotificationSettingsComponent {
  private readonly api = inject(ApiService);
  protected readonly supported =
    'serviceWorker' in navigator && 'PushManager' in globalThis && 'Notification' in globalThis;
  protected readonly standalone =
    globalThis.matchMedia?.('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true;
  protected readonly ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
  protected readonly subscribed = signal(false);
  protected readonly permission = signal<NotificationPermission | 'unsupported'>(
    'Notification' in globalThis ? Notification.permission : 'unsupported',
  );
  protected readonly installPrompt = signal<InstallPromptEvent | null>(null);
  protected readonly busy = signal(false);
  protected readonly message = signal('');
  protected readonly error = signal('');
  /** Geführte Einrichtung beim Einschalten eines Schalters. */
  protected readonly guide = signal<'install' | 'push' | null>(null);
  protected readonly android = /Android/.test(navigator.userAgent);
  protected readonly safariMac =
    /Macintosh/.test(navigator.userAgent) &&
    /Safari/.test(navigator.userAgent) &&
    !/Chrome|Edg/.test(navigator.userAgent);

  constructor() {
    globalThis.addEventListener('beforeinstallprompt', (event) => {
      event.preventDefault();
      this.installPrompt.set(event as InstallPromptEvent);
    });
    void this.refresh();
  }

  protected async install(): Promise<void> {
    await this.installPrompt()?.prompt();
    this.installPrompt.set(null);
  }

  /** Schalter „Als App“: direkt installieren, wo der Browser das anbietet, sonst Anleitung zeigen. */
  protected async toggleInstall(): Promise<void> {
    if (this.standalone) return;
    if (this.installPrompt()) {
      await this.install();
      return;
    }
    this.guide.set('install');
  }

  /** Schalter „Push“: einschalten führt durch Freigabe (bzw. zuerst durch die Installation auf dem iPhone). */
  protected async togglePush(): Promise<void> {
    if (this.subscribed()) {
      await this.disable();
      return;
    }
    this.guide.set(this.ios && !this.standalone ? 'install' : 'push');
  }

  /** Letzter Schritt der Anleitung: Browser-Dialog auslösen, anmelden, Testnachricht senden. */
  protected async allowAndSubscribe(): Promise<void> {
    await this.enable();
    if (this.subscribed()) {
      this.guide.set(null);
      await this.test();
    }
  }

  protected async enable(): Promise<void> {
    await this.run(async () => {
      const permission = await Notification.requestPermission();
      this.permission.set(permission);
      if (permission !== 'granted') throw new Error('Benachrichtigungen wurden im Browser nicht erlaubt.');
      const registration = await navigator.serviceWorker.ready;
      const { publicKey } = await this.api.get<{ publicKey: string }>('/api/push/key');
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: base64UrlToBytes(publicKey),
      });
      await this.api.post('/api/push/subscribe', subscription.toJSON());
      this.message.set('Benachrichtigungen sind auf diesem Gerät aktiv.');
    });
  }

  protected async disable(): Promise<void> {
    await this.run(async () => {
      const subscription = await (await navigator.serviceWorker.ready).pushManager.getSubscription();
      if (subscription) {
        await this.api.post('/api/push/unsubscribe', { endpoint: subscription.endpoint });
        await subscription.unsubscribe();
      }
      this.message.set('Benachrichtigungen sind auf diesem Gerät aus.');
    });
  }

  protected async test(): Promise<void> {
    await this.run(async () => {
      const result = await this.api.post<{ sent: number }>('/api/push/test');
      this.message.set(result.sent ? `Testnachricht an ${result.sent} Gerät(e) gesendet.` : 'Kein Gerät angemeldet.');
    });
  }

  private async refresh(): Promise<void> {
    if (!this.supported) return;
    const registration = await navigator.serviceWorker.getRegistration();
    this.subscribed.set(Boolean(await registration?.pushManager.getSubscription()));
  }

  private async run(action: () => Promise<void>): Promise<void> {
    this.busy.set(true);
    this.error.set('');
    this.message.set('');
    try {
      await action();
    } catch (error) {
      this.error.set(errorMessage(error, 'Aktion fehlgeschlagen.'));
    } finally {
      await this.refresh().catch(() => undefined);
      this.busy.set(false);
    }
  }
}
