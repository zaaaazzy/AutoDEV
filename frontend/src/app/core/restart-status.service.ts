import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import { ApiService } from './api.service.js';
import { AuthService } from './auth.service.js';
import { visibleInterval } from './visible-interval.js';

/** Stand des Neustarts von AIdeation (GET/POST/DELETE /api/system/restart). */
export interface RestartState {
  status: 'requested' | 'building' | 'restarting' | 'done' | 'failed' | 'cancelled';
  requestedAt: string;
  requestedBy: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  message?: string | null;
  log?: string | null;
  cancelledBy?: string | null;
}

export const RESTART_OPEN: readonly RestartState['status'][] = ['requested', 'building', 'restarting'];

/** Während eines Neustarts oft nachfragen, sonst selten (ein Neustart kann auch der Autopilot anstoßen). */
const FAST_MS = 3_000;
const SLOW_MS = 60_000;

/**
 * Gemeinsamer Stand des Neustarts für Statusleiste und Aktionen-Menü (nur Administration). Während des Neubaus ist
 * die API kurz weg: Dann bleibt der letzte Stand stehen und `unreachable` sagt, dass gerade getauscht wird.
 */
@Injectable({ providedIn: 'root' })
export class RestartStatusService {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  readonly state = signal<RestartState | null>(null);
  readonly unreachable = signal(false);
  readonly open = computed(() => RESTART_OPEN.includes(this.state()?.status ?? 'done'));
  private lastSlow = 0;

  constructor() {
    inject(DestroyRef).onDestroy(
      visibleInterval(() => {
        const now = Date.now();
        if (this.open() || now - this.lastSlow >= SLOW_MS) {
          if (!this.open()) this.lastSlow = now;
          void this.load();
        }
      }, FAST_MS),
    );
  }

  set(state: RestartState | null): void {
    this.state.set(state);
    this.unreachable.set(false);
  }

  /** Wartenden Neustart zurücknehmen (nur Status „requested“); die Antwort bringt den aktuellen Stand mit. */
  async cancel(): Promise<void> {
    try {
      const { restart } = await this.api.delete<{ restart: RestartState | null }>('/api/system/restart');
      this.set(restart);
    } catch (error) {
      // 409: der Worker baut schon – den tatsächlichen Stand holen, damit die Leiste ihn zeigt.
      await this.load();
      throw error;
    }
  }

  async load(): Promise<void> {
    if (!this.auth.can('admin')) return;
    try {
      const { restart } = await this.api.get<{ restart: RestartState | null }>('/api/system/restart');
      this.set(restart);
    } catch {
      // Während des Neustarts ist die API kurz weg – nächster Versuch beim nächsten Takt.
      if (this.open()) this.unreachable.set(true);
    }
  }
}
