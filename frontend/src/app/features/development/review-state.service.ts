import { Injectable, effect, inject, signal, untracked } from '@angular/core';
import { ApiService } from '../../core/api.service.js';
import type { ReviewState } from '../../core/models.js';
import { ProjectStore } from '../../core/project-store.js';

const REVIEW_REFRESH_MS = 5000;

/**
 * Stand der Review-Container, gemeinsam für alle Freigabe-Boxen: genau ein Poll, egal wie viele Aufträge
 * gerade auf Freigabe warten. Er läuft nur, solange mindestens eine Box angezeigt wird.
 */
@Injectable({ providedIn: 'root' })
export class ReviewStateService {
  private readonly api = inject(ApiService);
  private readonly store = inject(ProjectStore);
  readonly state = signal<ReviewState | null>(null);
  private subscribers = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    // Projektwechsel: alten Stand verwerfen und sofort für das neue Projekt laden.
    let lastProject = this.store.activeProject();
    effect(() => {
      const project = this.store.activeProject();
      if (project === lastProject) return;
      lastProject = project;
      untracked(() => {
        this.state.set(null);
        if (this.subscribers) void this.refresh();
      });
    });
  }

  /** Meldet eine Freigabe-Box an; die zurückgegebene Funktion meldet sie wieder ab. */
  subscribe(): () => void {
    this.subscribers++;
    if (!this.timer) {
      void this.refresh();
      this.timer = setInterval(() => void this.refresh(), REVIEW_REFRESH_MS);
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.subscribers--;
      if (!this.subscribers && this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
    };
  }

  async refresh(): Promise<void> {
    const project = this.store.activeProject();
    if (!project) return;
    try {
      const state = await this.api.get<ReviewState>(`/api/projects/${encodeURIComponent(project)}/review`);
      if (project === this.store.activeProject()) this.state.set(state);
    } catch {
      // Nächster Versuch beim nächsten Intervall.
    }
  }
}
