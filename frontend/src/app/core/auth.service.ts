import { HttpClient } from '@angular/common/http';
import { inject, Injectable, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

export type Role = 'admin' | 'agents' | 'run' | 'plan' | 'docs' | 'editor' | 'chat';

export interface CurrentUser {
  id: string | null;
  username: string;
  displayName: string;
  roles: Role[];
}

/** Anmeldestatus und Rollen. Bei 401 zeigt die Oberfläche die Login-Seite. */
@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly http = inject(HttpClient);
  private readonly basePath = globalThis.location.pathname.startsWith('/dev-log/') ? '/dev-log' : '';
  readonly required = signal(false);
  readonly user = signal<CurrentUser | null>(null);

  constructor() {
    void this.refresh();
  }

  async refresh(): Promise<void> {
    try {
      const session = await firstValueFrom(
        this.http.get<{ authenticated: boolean; user: CurrentUser | null }>(`${this.basePath}/api/session`),
      );
      this.user.set(session.authenticated ? session.user : null);
    } catch {
      this.user.set(null);
    }
  }

  /** Administration umfasst alle Rollen. */
  can(role: Role): boolean {
    const roles = this.user()?.roles ?? [];
    return roles.includes('admin') || roles.includes(role);
  }
}
