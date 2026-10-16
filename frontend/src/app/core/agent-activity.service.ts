import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import { ApiService } from './api.service.js';
import { errorMessage } from './errors.js';
import type { AgentActivity, UpcomingTask } from './models.js';
import { ProjectStore } from './project-store.js';

const LIVE_REFRESH_MS = 3_000;

/** Aufgaben des gerade geöffneten Agents; wird von der Agent-Liste (Kopfzeile, Dashboard) und der Agent-Detailansicht genutzt. */
@Injectable({ providedIn: 'root' })
export class AgentActivityService {
  private readonly api = inject(ApiService);
  private readonly store = inject(ProjectStore);

  readonly activity = signal<AgentActivity[]>([]);
  readonly upcoming = signal<UpcomingTask[]>([]);
  readonly loading = signal(false);
  readonly active = computed(() => this.activity().filter((entry) => entry.stepStatus === 'running'));
  readonly done = computed(() => this.activity().filter((entry) => entry.stepStatus !== 'running'));

  constructor() {
    const timer = globalThis.setInterval(() => void this.refreshLive(), LIVE_REFRESH_MS);
    inject(DestroyRef).onDestroy(() => globalThis.clearInterval(timer));
  }

  async show(id: string): Promise<void> {
    this.store.navigate('agents');
    this.store.openAgent.set(id);
    this.activity.set([]);
    this.upcoming.set([]);
    this.loading.set(true);
    try {
      const result = await this.api.get<{ activity: AgentActivity[]; upcoming: UpcomingTask[] }>(this.activityPath(id));
      if (this.store.openAgent() === id) {
        this.activity.set(result.activity);
        this.upcoming.set(result.upcoming ?? []);
      }
    } catch (error) {
      this.store.notice.set(errorMessage(error, 'Aufgaben des Agents konnten nicht geladen werden.'));
    } finally {
      this.loading.set(false);
    }
  }

  private refreshLive(): void {
    const agentId = this.store.openAgent();
    const running = this.store.data().agentRuns.some((run) => run.steps.some((step) => step.status === 'running'));
    if (!agentId || !this.store.activeProject() || !running) return;
    this.api.get<{ activity: AgentActivity[] }>(this.activityPath(agentId))
      .then((result) => { if (this.store.openAgent() === agentId) this.activity.set(result.activity); })
      .catch(() => undefined);
  }

  private activityPath(agentId: string): string {
    return `${this.api.projectPath(this.store.activeProject())}/agents/${encodeURIComponent(agentId)}/activity`;
  }
}
