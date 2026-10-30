import { HttpClient, HttpErrorResponse } from '@angular/common/http';
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

  async refresh(attempt = 0): Promise<void> {
    try {
      const session = await firstValueFrom(
        this.http.get<{ authenticated: boolean; user: CurrentUser | null }>(`${this.basePath}/api/session`),
      );
      this.user.set(session.authenticated ? session.user : null);
    } catch (error) {
      this.user.set(null);
      if (error instanceof HttpErrorResponse && error.status === 401) {
        this.required.set(true);
        return;
      }
      // Server kurz weg (Neustart, Netz): ohne Sitzung fehlen alle Rollen und Aktionen bleiben ausgeblendet –
      // deshalb erneut versuchen statt bis zum Neuladen ohne Rechte weiterzulaufen.
      setTimeout(() => void this.refresh(attempt + 1), Math.min(30_000, 1_000 * 2 ** attempt));
    }
  }

  /** Administration umfasst alle Rollen. */
  can(role: Role): boolean {
    const roles = this.user()?.roles ?? [];
    return roles.includes('admin') || roles.includes(role);
  }
}
