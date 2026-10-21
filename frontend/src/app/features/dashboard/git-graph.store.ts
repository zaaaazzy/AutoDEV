import { effect, inject, Injectable, OnDestroy, signal } from '@angular/core';
import { ApiService } from '../../core/api.service.js';
import { ProjectStore } from '../../core/project-store.js';
import { visibleInterval } from '../../core/visible-interval.js';
import type { GitGraph } from './git-graph.js';

const REFRESH_MS = 60_000;

/** Git-Verlauf des aktiven Projekts, jede Minute neu geladen (nicht bei verborgenem Tab); geteilt von Panel und Rand-Dekoration. */
@Injectable()
export class GitGraphStore implements OnDestroy {
  private readonly api = inject(ApiService);
  private readonly store = inject(ProjectStore);
  readonly graph = signal<GitGraph | null>(null);
  readonly loaded = signal(false);
  private stopTimer: (() => void) | undefined;

  constructor() {
    effect(() => {
      const slug = this.store.activeProject();
      this.graph.set(null);
      this.loaded.set(false);
      this.stopTimer?.();
      this.stopTimer = undefined;
      if (!slug) return;
      void this.load(slug);
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
    this.graph.set(result?.graph ?? null);
    this.loaded.set(true);
  }
}
