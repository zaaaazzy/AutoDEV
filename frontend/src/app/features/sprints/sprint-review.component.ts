import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../core/api.service.js';
import { AuthService } from '../../core/auth.service.js';
import type { ReviewSlot, Sprint, SprintCommit } from '../../core/models.js';
import { ProjectStore } from '../../core/project-store.js';
import { ReviewLaunchService } from '../../core/review-launch.service.js';
import { formatIsoDate } from '../../shared/format.js';
import { WaitStatusComponent } from '../runs/wait-status.component.js';
import { commitOptionLabel, reviewStarting, reviewStatusText, sprintReviewSlot } from './review-launch.js';

/**
 * Einen Stand (Commit) des Sprints wählen und mit ▶ in einem Review-Container starten.
 * Sprint-Ansicht und Sprint-Popover der Kopfzeile (compact, öffnet den Container automatisch) nutzen dieselbe Komponente.
 */
@Component({
  selector: 'app-sprint-review',
  standalone: true,
  imports: [FormsModule, WaitStatusComponent],
  template: `
    <div class="sprint-review" [class.compact]="compact()">
      <label class="sprint-review-pick">
        <span>{{ compact() ? 'Stand im Review starten' : 'Version ansehen' }}</span>
        <select [(ngModel)]="chosen" [disabled]="!commits().length || !auth.can('run')" name="sprint-review-commit">
          @for (commit of commits(); track commit.hash) {
            <option [value]="commit.hash">{{ optionLabel(commit) }}</option>
          } @empty {
            <option value="">Noch keine Stände in diesem Sprint</option>
          }
        </select>
      </label>
      <button
        class="button primary sprint-review-play"
        type="button"
        [disabled]="!chosen || launch.busy() || !auth.can('run')"
        (click)="start()"
        title="Im Review-Container starten"
        aria-label="Im Review-Container starten"
      >
        ▶
      </button>
      @if (launch.busy()) {
        <span class="sprint-review-status starting" role="status">
          <span class="review-spinner" aria-hidden="true"></span> Stand wird gestartet …
        </span>
      } @else if (mine(); as slot) {
        <span class="sprint-review-status" [class]="'sprint-review-status ' + slot.status" role="status">
          @if (starting()) {
            <span class="review-spinner" aria-hidden="true"></span>
          }
          @if (slot.status === 'running' && wait.status()) {
            Review {{ slot.slot }}
          } @else {
            Review {{ slot.slot }}: {{ statusText(slot) }}
          }
          @if (slot.status === 'running') {
            · <a [href]="slot.url" target="_blank" rel="noopener">{{ compact() ? 'öffnen' : slot.url }} ↗</a>
          }
          @if (slot.status !== 'idle' && slot.status !== 'stopping' && auth.can('run')) {
            · <button class="link-button" type="button" (click)="stop(slot)">beenden</button>
          }
        </span>
      }
      <!-- Test, Test-Gate oder Push laufen noch: statt „Review läuft“ sagen, wie lange es noch dauert. -->
      <app-wait-status #wait />
      @if (compact() && launch.blockedUrl(); as url) {
        <span class="sprint-review-status">
          Der Browser hat das Öffnen blockiert –
          <a [href]="url" target="_blank" rel="noopener">Review-Container öffnen ↗</a>
        </span>
      }
    </div>
    @if (!compact() && mine()?.status === 'failed' && mine()?.message) {
      <pre class="approval-log">{{ mine()?.message }}</pre>
    }
    @if (launch.error()) {
      <p class="folder-picker-error" role="alert">Fehler: {{ launch.error() }}</p>
    }
  `,
})
export class SprintReviewComponent {
  private readonly api = inject(ApiService);
  private readonly store = inject(ProjectStore);
  protected readonly auth = inject(AuthService);
  protected readonly launch = inject(ReviewLaunchService);
  readonly sprint = input.required<Pick<Sprint, 'id'>>();
  /** Kurzfassung für das Sprint-Popover; öffnet den gestarteten Container automatisch in einem neuen Tab. */
  readonly compact = input(false);

  protected readonly commits = signal<SprintCommit[]>([]);
  protected chosen = '';
  /** Container, der gerade einen Stand dieses Sprints zeigt. */
  protected readonly mine = computed(() =>
    sprintReviewSlot(this.launch.slots(), this.store.activeProject(), this.commits(), this.launch.pending()),
  );
  protected readonly starting = computed(() => reviewStarting(this.mine()));

  constructor() {
    effect((onCleanup) => {
      const id = this.sprint().id;
      void this.load(id);
      const timer = setInterval(() => void this.load(id), 5000);
      onCleanup(() => clearInterval(timer));
    });
  }

  private async load(id: string): Promise<void> {
    // Ohne Container-Status bleibt die Auswahl trotzdem sichtbar (nächster Versuch beim nächsten Intervall).
    void this.launch.loadSlots().catch(() => undefined);
    try {
      const commits = await this.api.get<{ commits: SprintCommit[] }>(`/api/sprints/${encodeURIComponent(id)}/commits`);
      this.commits.set(commits.commits);
      if (!this.chosen || !commits.commits.some((commit) => commit.hash === this.chosen)) {
        this.chosen = commits.commits[0]?.hash ?? '';
      }
    } catch {
      // Nächster Versuch beim nächsten Intervall.
    }
  }

  protected optionLabel(commit: SprintCommit): string {
    return commitOptionLabel(commit, formatIsoDate(commit.date));
  }

  protected statusText(slot: ReviewSlot): string {
    return reviewStatusText(slot);
  }

  protected start(): void {
    const commit = this.commits().find((entry) => entry.hash === this.chosen);
    if (!commit || !this.auth.can('run')) return;
    void this.launch.start(this.store.activeProject(), commit, this.compact());
  }

  protected stop(slot: ReviewSlot): Promise<void> {
    return this.launch.stop(slot);
  }
}
