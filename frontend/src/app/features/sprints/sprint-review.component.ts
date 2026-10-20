import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../core/api.service.js';
import { AuthService } from '../../core/auth.service.js';
import type { ReviewSlot, Sprint, SprintCommit } from '../../core/models.js';
import { ProjectStore } from '../../core/project-store.js';
import { formatIsoDate } from '../../shared/format.js';

const STATUS_TEXT: Record<ReviewSlot['status'], string> = {
  idle: 'frei',
  requested: 'angefordert …',
  starting: 'startet (Abhängigkeiten, Datenbank-Kopie) …',
  running: 'läuft',
  failed: 'Start fehlgeschlagen',
  stopping: 'wird beendet …',
};

/** Sprint-Ansicht: einen Stand (Commit) des Sprints wählen und mit ▶ in einem Review-Container starten. */
@Component({
  selector: 'app-sprint-review',
  standalone: true,
  imports: [FormsModule],
  template: `
    <div class="sprint-review">
      <label class="sprint-review-pick">
        <span>Version ansehen</span>
        <select [(ngModel)]="chosen" [disabled]="!commits().length" name="sprint-review-commit">
          @for (commit of commits(); track commit.hash) {
            <option [value]="commit.hash">
              {{ commit.merged ? '' : '◌ ' }}{{ commit.subject }} · {{ commit.hash.slice(0, 7) }} ·
              {{ date(commit.date) }}
            </option>
          } @empty {
            <option value="">Noch keine Stände in diesem Sprint</option>
          }
        </select>
      </label>
      <button
        class="button primary sprint-review-play"
        type="button"
        [disabled]="!chosen || busy() || !auth.can('run')"
        (click)="start()"
        title="Im Review-Container starten"
        aria-label="Im Review-Container starten"
      >
        ▶
      </button>
      @if (mine(); as slot) {
        <span class="sprint-review-status" [class]="'sprint-review-status ' + slot.status">
          Review {{ slot.slot }}: {{ statusText(slot) }}
          @if (slot.status === 'running') {
            · <a [href]="slot.url" target="_blank" rel="noopener">{{ slot.url }} ↗</a>
          }
          @if (slot.status !== 'idle' && slot.status !== 'stopping' && auth.can('run')) {
            · <button class="link-button" type="button" (click)="stop(slot)">beenden</button>
          }
        </span>
      }
    </div>
    @if (mine()?.status === 'failed' && mine()?.message) {
      <pre class="approval-log">{{ mine()?.message }}</pre>
    }
    @if (error()) {
      <p class="folder-picker-error">{{ error() }}</p>
    }
  `,
})
export class SprintReviewComponent {
  private readonly api = inject(ApiService);
  private readonly store = inject(ProjectStore);
  protected readonly auth = inject(AuthService);
  readonly sprint = input.required<Sprint>();

  protected readonly commits = signal<SprintCommit[]>([]);
  protected readonly slots = signal<ReviewSlot[]>([]);
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected chosen = '';
  /** Container, der gerade einen Stand dieses Sprints zeigt. */
  protected readonly mine = computed(() => {
    const hashes = new Set(this.commits().map((commit) => commit.hash));
    const project = this.store.activeProject();
    return (
      this.slots().find((slot) => slot.projectSlug === project && slot.commit && hashes.has(slot.commit)) ??
      this.slots().find((slot) => slot.projectSlug === project && slot.status !== 'idle' && slot.kind === 'manual') ??
      null
    );
  });

  constructor() {
    effect((onCleanup) => {
      const id = this.sprint().id;
      void this.load(id);
      const timer = setInterval(() => void this.load(id), 5000);
      onCleanup(() => clearInterval(timer));
    });
  }

  private async load(id: string): Promise<void> {
    try {
      const [commits, slots] = await Promise.all([
        this.api.get<{ commits: SprintCommit[] }>(`/api/sprints/${encodeURIComponent(id)}/commits`),
        this.api.get<{ slots: ReviewSlot[] }>('/api/review-slots'),
      ]);
      this.commits.set(commits.commits);
      this.slots.set(slots.slots);
      if (!this.chosen || !commits.commits.some((commit) => commit.hash === this.chosen)) {
        this.chosen = commits.commits[0]?.hash ?? '';
      }
    } catch {
      // Nächster Versuch beim nächsten Intervall.
    }
  }

  protected date(value: string): string {
    return formatIsoDate(value);
  }

  protected statusText(slot: ReviewSlot): string {
    return STATUS_TEXT[slot.status];
  }

  protected async start(): Promise<void> {
    const commit = this.commits().find((entry) => entry.hash === this.chosen);
    if (!commit) return;
    this.busy.set(true);
    this.error.set('');
    try {
      await this.api.post(`/api/projects/${encodeURIComponent(this.store.activeProject())}/review-slots/start`, {
        commit: commit.hash,
        label: commit.subject,
        developmentId: commit.developmentId,
      });
      await this.load(this.sprint().id);
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : 'Start fehlgeschlagen.');
    } finally {
      this.busy.set(false);
    }
  }

  protected async stop(slot: ReviewSlot): Promise<void> {
    await this.api.post(`/api/review-slots/${slot.slot}/stop`).catch(() => undefined);
    await this.load(this.sprint().id);
  }
}
