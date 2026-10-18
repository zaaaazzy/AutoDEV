import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../core/api.service.js';
import { AuthService, type Role } from '../../core/auth.service.js';
import { errorMessage } from '../../core/errors.js';
import { DateTimePipe } from '../../shared/pipes.js';

interface ManagedUser {
  id: string;
  username: string;
  displayName: string;
  roles: Role[];
  active: boolean;
  totp: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

interface RoleInfo {
  id: Role;
  label: string;
  description: string;
}

/** Benutzer und Rollen verwalten (nur Administration). */
@Component({
  selector: 'app-users-settings',
  standalone: true,
  imports: [FormsModule, DateTimePipe],
  templateUrl: './users-settings.component.html',
})
export class UsersSettingsComponent {
  private readonly api = inject(ApiService);
  protected readonly auth = inject(AuthService);
  protected readonly users = signal<ManagedUser[]>([]);
  protected readonly roles = signal<RoleInfo[]>([]);
  protected readonly systemAdmin = signal<{ username: string; totp: boolean } | null>(null);
  protected readonly editing = signal<string | null>(null);
  protected readonly creating = signal(false);
  protected readonly busy = signal(false);
  protected readonly message = signal('');
  protected readonly error = signal('');
  protected form = { username: '', displayName: '', password: '', roles: [] as Role[] };
  protected edit = { displayName: '', roles: [] as Role[], active: true, password: '' };

  constructor() {
    void this.load();
  }

  protected roleLabel(role: Role): string {
    return this.roles().find((entry) => entry.id === role)?.label ?? role;
  }

  protected toggle(list: Role[], role: Role, checked: boolean): Role[] {
    return checked ? [...new Set([...list, role])] : list.filter((entry) => entry !== role);
  }

  protected startEdit(user: ManagedUser): void {
    this.editing.set(this.editing() === user.id ? null : user.id);
    this.edit = { displayName: user.displayName, roles: [...user.roles], active: user.active, password: '' };
  }

  protected async create(): Promise<void> {
    await this.run(async () => {
      await this.api.post('/api/users', this.form);
      this.message.set(`Benutzer „${this.form.username}“ angelegt.`);
      this.form = { username: '', displayName: '', password: '', roles: [] };
      this.creating.set(false);
    });
  }

  protected async save(user: ManagedUser): Promise<void> {
    await this.run(async () => {
      await this.api.patch(`/api/users/${user.id}`, {
        displayName: this.edit.displayName,
        roles: this.edit.roles,
        active: this.edit.active,
      });
      if (this.edit.password) {
        await this.api.post(`/api/users/${user.id}/password`, { password: this.edit.password });
      }
      this.message.set(
        `Benutzer „${user.username}“ gespeichert${this.edit.password ? ' – neues Passwort gesetzt, Sitzungen beendet' : ''}.`,
      );
      this.editing.set(null);
    });
  }

  protected async resetTotp(user: ManagedUser): Promise<void> {
    if (!globalThis.confirm(`Zwei-Faktor-Anmeldung von „${user.username}“ zurücksetzen?`)) return;
    await this.run(async () => {
      await this.api.post(`/api/users/${user.id}/totp/reset`);
      this.message.set(`Zwei-Faktor von „${user.username}“ zurückgesetzt.`);
    });
  }

  protected async remove(user: ManagedUser): Promise<void> {
    if (!globalThis.confirm(`Benutzer „${user.username}“ endgültig löschen?`)) return;
    await this.run(async () => {
      await this.api.delete(`/api/users/${user.id}`);
      this.message.set(`Benutzer „${user.username}“ gelöscht.`);
    });
  }

  private async load(): Promise<void> {
    try {
      const result = await this.api.get<{
        users: ManagedUser[];
        roles: RoleInfo[];
        systemAdmin: { username: string; totp: boolean } | null;
      }>('/api/users');
      this.users.set(result.users);
      this.roles.set(result.roles);
      this.systemAdmin.set(result.systemAdmin);
    } catch (error) {
      this.error.set(errorMessage(error, 'Benutzer konnten nicht geladen werden.'));
    }
  }

  private async run(action: () => Promise<void>): Promise<void> {
    this.busy.set(true);
    this.error.set('');
    this.message.set('');
    try {
      await action();
      await this.load();
    } catch (error) {
      this.error.set(errorMessage(error, 'Aktion fehlgeschlagen.'));
    } finally {
      this.busy.set(false);
    }
  }
}
