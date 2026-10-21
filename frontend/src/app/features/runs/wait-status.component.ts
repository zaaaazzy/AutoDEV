import { Component, DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import { ApiService } from '../../core/api.service.js';
import { ProjectStore } from '../../core/project-store.js';
import type { LiveRun } from './test-run-live.js';
import { waitStatus } from './wait-status.js';

const POLL_MS = 3_000;
/** Steht nur ein Push an (noch kein Test), den Sprint-Stand seltener nachladen. */
const SYNC_RELOAD_MS = 15_000;

/** Laufender Testlauf, gemeinsam für alle Wartestatus-Anzeigen: ein Poll, solange mindestens eine sichtbar ist. */
@Injectable({ providedIn: 'root' })
export class TestLiveService {
  private readonly api = inject(ApiService);
  private readonly store = inject(ProjectStore);
  readonly live = signal<LiveRun | null>(null);
  private subscribers = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private lastSyncReload = 0;

  subscribe(): () => void {
    this.subscribers++;
    if (!this.timer) {
      void this.poll();
      this.timer = setInterval(() => void this.poll(), POLL_MS);
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

  private async poll(): Promise<void> {
    const slug = this.store.activeProject();
    if (this.busy || !slug || globalThis.document?.hidden) return;
    this.busy = true;
    try {
      const { run } = await this.api.get<{ run: LiveRun | null }>(`${this.api.projectPath(slug)}/test-runs/live`);
      if (slug !== this.store.activeProject()) return;
      const was = this.live();
      this.live.set(run);
      // Test fertig oder Push noch offen: Sprint-Stand (Git-Sicherung) und Testläufe nachladen.
      const syncing = this.store
        .data()
        .sprints.some((sprint) => sprint.gitSync === 'pending' || sprint.gitSync === 'running');
      const finished = was && (!run || run.id !== was.id);
      if (finished || (!run && syncing && Date.now() - this.lastSyncReload > SYNC_RELOAD_MS)) {
        this.lastSyncReload = Date.now();
        void this.store.loadProject(slug, true);
      }
    } catch {
      // Kurz nicht erreichbar: beim nächsten Takt erneut.
    } finally {
      this.busy = false;
    }
  }
}

/**
 * „Test läuft – bitte warte noch etwa 4 Min.“ mit Fortschrittsbalken: steht statt „Review läuft“, solange ein Test,
 * das Test-Gate oder ein Push den Stand gleich noch ändert.
 */
@Component({
  selector: 'app-wait-status',
  standalone: true,
  template: `
    @if (status(); as wait) {
      <span class="wait-status" role="status">
        <span class="wait-status-text"
          ><span class="review-spinner" aria-hidden="true"></span> <strong>{{ wait.label }}</strong> ·
          {{ wait.hint }}</span
        >
        <span
          class="wait-status-bar"
          [class.indeterminate]="wait.percent === null"
          role="progressbar"
          [attr.aria-label]="wait.label"
          aria-valuemin="0"
          aria-valuemax="100"
          [attr.aria-valuenow]="wait.percent"
        >
          <span [style.width.%]="wait.percent ?? 30"></span>
        </span>
      </span>
    }
  `,
})
export class WaitStatusComponent {
  private readonly store = inject(ProjectStore);
  private readonly testLive = inject(TestLiveService);

  readonly status = computed(() => {
    const data = this.store.data();
    const sprint =
      data.sprints.find((entry) => entry.gitSync === 'pending' || entry.gitSync === 'running') ??
      data.sprints.find((entry) => entry.status === 'active') ??
      null;
    return waitStatus(this.testLive.live(), sprint, data.runs);
  });

  constructor() {
    inject(DestroyRef).onDestroy(this.testLive.subscribe());
  }
}
