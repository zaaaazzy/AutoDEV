import { Component, DestroyRef, computed, inject } from '@angular/core';
import { FIX_LABEL, GitGuardService } from '../../core/git-guard.service.js';
import { ProjectStore } from '../../core/project-store.js';
import { ReviewStateService } from '../development/review-state.service.js';
import { WaitStatusComponent } from '../runs/wait-status.component.js';
import { runningActivities } from './running-activities.js';

const KIND_LABEL = { git: 'Git', agent: 'Agent', user: 'Deine Aktion' } as const;

/**
 * „Läuft gerade“ oben unter Aktionen: Tests und Git-Sicherung mit Fortschritt (Wartestatus-Karte), darunter Merge nach
 * einer Freigabe, Git-Lösungen, arbeitende Agents und startende Review-Container. Unsichtbar, wenn nichts läuft.
 */
@Component({
  selector: 'app-running-panel',
  standalone: true,
  imports: [WaitStatusComponent],
  template: `
    <details
      class="panel running-panel fold-panel"
      [hidden]="!wait.status() && !activities().length"
      aria-label="Läuft gerade"
      open
    >
      <summary class="section-heading">
        <div>
          <h2>
            Läuft gerade <span class="muted">({{ activities().length + (wait.status() ? 1 : 0) }})</span>
          </h2>
          <p class="muted">Git, Tests, Agents und was du angestossen hast – aktualisiert sich von selbst.</p>
        </div>
      </summary>
      <app-wait-status #wait [card]="true" />
      @if (activities().length) {
        <ul class="running-list">
          @for (activity of activities(); track $index) {
            <li [class]="'running-item ' + activity.kind">
              <span class="review-spinner" aria-hidden="true"></span>
              <span class="running-kind">{{ kindLabel[activity.kind] }}</span>
              <span class="running-text"
                ><strong>{{ activity.label }}</strong>
                @if (activity.detail) {
                  <small>{{ activity.detail }}</small>
                }
              </span>
            </li>
          }
        </ul>
      }
    </details>
  `,
})
export class RunningPanelComponent {
  private readonly store = inject(ProjectStore);
  private readonly guard = inject(GitGuardService);
  private readonly review = inject(ReviewStateService);
  protected readonly kindLabel = KIND_LABEL;

  protected readonly activities = computed(() => {
    const fix = this.guard.fixRunning();
    return runningActivities({
      development: this.store.data().development,
      agents: this.store.worker().agents,
      gitFix: fix ? FIX_LABEL[fix.fix] : null,
      slots: this.review.state()?.slots ?? [],
      project: this.store.activeProject(),
    });
  });

  constructor() {
    // Review-Container-Stand nur nachladen, solange die Seite offen ist (gemeinsamer Poll mit den Freigabe-Boxen).
    inject(DestroyRef).onDestroy(this.review.subscribe());
  }
}
