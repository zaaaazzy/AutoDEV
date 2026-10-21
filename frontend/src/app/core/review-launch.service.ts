import { DestroyRef, Injectable, inject, signal } from '@angular/core';
import { ApiService } from './api.service.js';
import { errorMessage } from './errors.js';
import type { ReviewSlot, SprintCommit } from './models.js';
import { visibleInterval } from './visible-interval.js';

const PENDING_REFRESH_MS = 2_000;

/**
 * Review-Container starten (Sprint-Ansicht und Sprint-Popover in der Kopfzeile teilen diesen Zustand):
 * Start anfragen, den gestarteten Container abfragen, bis er läuft oder scheitert, und seine Adresse dann öffnen.
 */
@Injectable({ providedIn: 'root' })
export class ReviewLaunchService {
  private readonly api = inject(ApiService);

  readonly slots = signal<ReviewSlot[]>([]);
  /** Start-Anfrage läuft. */
  readonly busy = signal(false);
  /** Fehlermeldung des Servers zur Start-Anfrage. */
  readonly error = signal('');
  /** Container, den dieses Fenster gestartet hat und dessen Adresse automatisch geöffnet wird. */
  readonly pending = signal<number | null>(null);
  /** Der Browser hat das Öffnen blockiert: Adresse für den Link im Popover. */
  readonly blockedUrl = signal<string | null>(null);
  /** Im Klick reservierter Tab (sonst blockiert der Popup-Blocker das Öffnen nach der Antwort). */
  private tab: Window | null = null;
  private stopTimer: (() => void) | null = null;

  constructor() {
    inject(DestroyRef).onDestroy(() => this.stopPolling());
  }

  async loadSlots(): Promise<void> {
    const result = await this.api.get<{ slots: ReviewSlot[] }>('/api/review-slots');
    this.slots.set(result.slots);
    this.follow();
  }

  /** Stand starten; mit autoOpen öffnet sich der Review-Container in einem neuen Tab, sobald er läuft. */
  async start(project: string, commit: SprintCommit, autoOpen: boolean): Promise<void> {
    if (this.busy()) return;
    this.closeTab();
    // Synchron im Klick reservieren, erst danach auf die Antwort warten.
    if (autoOpen) this.tab = this.reserveTab();
    this.busy.set(true);
    this.error.set('');
    this.blockedUrl.set(null);
    this.pending.set(null);
    try {
      const result = await this.api.post<{ slot: number }>(
        `/api/projects/${encodeURIComponent(project)}/review-slots/start`,
        { commit: commit.hash, label: commit.subject, developmentId: commit.developmentId },
      );
      if (autoOpen) {
        this.pending.set(result.slot);
        this.startPolling();
      }
      await this.loadSlots().catch(() => undefined);
    } catch (error) {
      this.closeTab();
      this.error.set(errorMessage(error, 'Start fehlgeschlagen.'));
    } finally {
      this.busy.set(false);
    }
  }

  async stop(slot: ReviewSlot): Promise<void> {
    if (slot.slot === this.pending()) this.finish();
    await this.api.post(`/api/review-slots/${slot.slot}/stop`).catch(() => undefined);
    await this.loadSlots().catch(() => undefined);
  }

  /** Gestarteten Container verfolgen: läuft er mit Adresse, wird sie geöffnet; scheitert er, endet die Verfolgung. */
  private follow(): void {
    const pending = this.pending();
    if (pending === null) return;
    const slot = this.slots().find((entry) => entry.slot === pending);
    if (!slot || slot.status === 'failed' || slot.status === 'idle' || slot.status === 'stopping') {
      this.finish();
      return;
    }
    if (slot.status !== 'running' || !slot.url) return;
    if (this.tab && !this.tab.closed) {
      this.tab.location.href = slot.url;
      this.tab = null;
    } else {
      // Ohne reservierten Tab (blockiert oder geschlossen): neu öffnen, sonst Link im Popover.
      const opened = globalThis.open(slot.url, '_blank');
      if (opened) opened.opener = null;
      else this.blockedUrl.set(slot.url);
    }
    this.pending.set(null);
    this.stopPolling();
  }

  private reserveTab(): Window | null {
    const tab = globalThis.open('', '_blank');
    if (!tab) return null;
    try {
      tab.opener = null;
      tab.document.title = 'Review startet …';
      tab.document.body.textContent = 'Der Review-Container startet … diese Seite wechselt automatisch.';
    } catch {
      // Ohne Zugriff bleibt der Tab leer, die Weiterleitung klappt trotzdem.
    }
    return tab;
  }

  private finish(): void {
    this.pending.set(null);
    this.stopPolling();
    this.closeTab();
  }

  private closeTab(): void {
    if (this.tab && !this.tab.closed) this.tab.close();
    this.tab = null;
  }

  private startPolling(): void {
    this.stopPolling();
    this.stopTimer = visibleInterval(() => void this.loadSlots().catch(() => undefined), PENDING_REFRESH_MS);
  }

  private stopPolling(): void {
    this.stopTimer?.();
    this.stopTimer = null;
  }
}
