import { effect, inject, Injectable, OnDestroy, signal } from '@angular/core';
import { ApiService } from '../../core/api.service.js';
import { ProjectStore } from '../../core/project-store.js';
import type { GitGraph } from './git-graph.js';

const REFRESH_MS = 60_000;

/** Git-Verlauf des aktiven Projekts, jede Minute neu geladen; geteilt von Panel und Rand-Dekoration. */
@Injectable()
export class GitGraphStore implements OnDestroy {
  private readonly api = inject(ApiService);
  private readonly store = inject(ProjectStore);
  readonly graph = signal<GitGraph | null>(null);
  readonly loaded = signal(false);
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor() {
    effect(() => {
      const slug = this.store.activeProject();
      this.graph.set(null);
      this.loaded.set(false);
      clearInterval(this.timer);
      if (!slug) return;
      void this.load(slug);
      this.timer = setInterval(() => void this.load(slug), REFRESH_MS);
    });
  }

  ngOnDestroy(): void {
    clearInterval(this.timer);
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
