import { computed, effect, inject, Injectable, OnDestroy, signal } from '@angular/core';
import { ApiService } from '../../core/api.service.js';
import { ProjectStore } from '../../core/project-store.js';
import { visibleInterval } from '../../core/visible-interval.js';
import { EMPTY_GIT_GRAPH_STATE, type GitGraph, nextGitGraphState } from './git-graph.js';

const REFRESH_MS = 60_000;

/**
 * Git-Verlauf des aktiven Projekts, jede Minute neu geladen (nicht bei verborgenem Tab); geteilt von Panel und
 * Rand-Dekoration. Ein gescheiterter Abruf behält den letzten Stand und setzt nur `error`; geleert wird nur beim
 * Projektwechsel.
 */
@Injectable()
export class GitGraphStore implements OnDestroy {
  private readonly api = inject(ApiService);
  private readonly store = inject(ProjectStore);
  private readonly state = signal(EMPTY_GIT_GRAPH_STATE);
  readonly graph = computed(() => this.state().graph);
  readonly loaded = computed(() => this.state().loaded);
  /** Letzter Abruf gescheitert (der angezeigte Stand kann veraltet sein). */
  readonly error = computed(() => this.state().error);
  private stopTimer: (() => void) | undefined;

  constructor() {
    effect(() => {
      const slug = this.store.activeProject();
      this.state.set(EMPTY_GIT_GRAPH_STATE);
      this.stopTimer?.();
      this.stopTimer = undefined;
      if (!slug) return;
      // Verborgener Tab: visibleInterval lädt beim Sichtbarwerden sofort nach.
      if (!globalThis.document?.hidden) void this.load(slug);
      this.stopTimer = visibleInterval(() => void this.load(slug), REFRESH_MS);
    });
  }

  ngOnDestroy(): void {
    this.stopTimer?.();
  }

  private async load(slug: string): Promise<void> {
    const result = await this.api
      .get<{ graph: GitGraph | null }>(`${this.api.projectPath(slug)}/git-graph`)
      .catch(() => null);
    if (slug !== this.store.activeProject()) return;
    this.state.update((state) => nextGitGraphState(state, result));
  }
}
