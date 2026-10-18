import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../core/api.service.js';
import { errorMessage } from '../../core/errors.js';

/** Login-Seite mit Benutzername, Passwort und – falls eingerichtet – Code aus der Authenticator-App. */
@Component({
  selector: 'app-login',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './login.component.html',
})
export class LoginComponent {
  private readonly api = inject(ApiService);
  protected readonly totp = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected username = '';
  protected password = '';
  protected code = '';

  constructor() {
    void this.api
      .get<{ totp: boolean }>('/api/session')
      .then((session) => this.totp.set(session.totp))
      .catch(() => undefined);
  }

  protected async login(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    try {
      await this.api.post('/api/login', { username: this.username.trim(), password: this.password, code: this.code });
      globalThis.location.reload();
    } catch (error) {
      const body = (error as { cause?: { error?: { totp?: boolean } } }).cause?.error;
      if (body?.totp) this.totp.set(true);
      this.error.set(errorMessage(error, 'Anmeldung fehlgeschlagen.'));
      this.code = '';
      this.busy.set(false);
    }
  }
}
