import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../core/api.service.js';
import { errorMessage } from '../../core/errors.js';

interface AuthStatus {
  totp: boolean;
  sessions: number;
  sessionLogin: boolean;
}

/** Zwei-Faktor-Anmeldung einrichten, andere Geräte abmelden, selbst abmelden. */
@Component({
  selector: 'app-security-settings',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './security-settings.component.html',
})
export class SecuritySettingsComponent {
  private readonly api = inject(ApiService);
  protected readonly status = signal<AuthStatus | null>(null);
  protected readonly setup = signal<{ secret: string; qr: string } | null>(null);
  protected readonly message = signal('');
  protected readonly error = signal('');
  protected readonly busy = signal(false);
  protected code = '';
  /** Aktuelles Passwort: Einrichten und Bestätigen der Zwei-Faktor-Anmeldung verlangen es (bis dahin nur im Speicher). */
  protected password = '';

  constructor() {
    void this.load();
  }

  protected async startSetup(): Promise<void> {
    await this.run(async () => {
      this.setup.set(
        await this.api.post<{ secret: string; qr: string }>('/api/auth/totp/setup', { password: this.password }),
      );
      this.code = '';
    });
  }

  protected cancelSetup(): void {
    this.setup.set(null);
    this.password = '';
    this.code = '';
  }

  protected async enable(): Promise<void> {
    await this.run(async () => {
      await this.api.post('/api/auth/totp/enable', { password: this.password, code: this.code });
      this.setup.set(null);
      this.password = '';
      this.code = '';
      this.message.set('Zwei-Faktor-Anmeldung ist aktiv. Andere Geräte müssen sich neu anmelden.');
      await this.load();
    });
  }

  protected async disable(): Promise<void> {
    await this.run(async () => {
      await this.api.post('/api/auth/totp/disable', { password: this.password, currentCode: this.code });
      this.password = '';
      this.code = '';
      this.message.set('Zwei-Faktor-Anmeldung ist ausgeschaltet.');
      await this.load();
    });
  }

  protected async logoutOthers(): Promise<void> {
    await this.run(async () => {
      const result = await this.api.post<{ removed: number }>('/api/auth/logout-others');
      this.message.set(`${result.removed} andere Sitzung(en) abgemeldet.`);
      await this.load();
    });
  }

  protected async logout(): Promise<void> {
    await this.run(async () => {
      await this.api.post('/api/logout');
      globalThis.location.reload();
    });
  }

  private async load(): Promise<void> {
    try {
      this.status.set(await this.api.get<AuthStatus>('/api/auth/status'));
    } catch {
      this.status.set(null);
    }
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
      this.busy.set(false);
    }
  }
}
