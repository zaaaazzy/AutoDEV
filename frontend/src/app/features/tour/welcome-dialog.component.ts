import { Component, output } from '@angular/core';

/** Begrüßung beim ersten Start: Projekt anlegen oder Tour starten. */
@Component({
  selector: 'app-welcome-dialog',
  standalone: true,
  template: `
    <div class="modal-backdrop welcome-backdrop">
      <section class="welcome-card" role="dialog" aria-modal="true" aria-labelledby="welcome-title">
        <span class="brand-mark welcome-mark">m</span>
        <h2 id="welcome-title">{{ afterProject ? 'Dein Projekt ist bereit' : 'Hallo! Willkommen bei AIdeation' }}</h2>
        <p>
          {{
            afterProject
              ? 'Möchtest du in einer kurzen Tour sehen, wie aus einer Idee ein Auftrag wird und Agents ihn umsetzen?'
              : hasProjects
                ? 'Möchtest du ein neues Projekt anlegen oder dir in einer kurzen Tour zeigen lassen, wie alles zusammenspielt?'
                : 'Hier steuerst du Agents, die deine Projekte planen, umsetzen, testen und dokumentieren. Möchtest du dein erstes Projekt anlegen?'
          }}
        </p>
        <div class="welcome-actions">
          @if (!afterProject) {
            <button class="button primary" type="button" (click)="createProject.emit()">Projekt erstellen</button>
          }
          @if (hasProjects || afterProject) {
            <button
              class="button"
              [class.primary]="afterProject"
              [class.secondary]="!afterProject"
              type="button"
              (click)="startTour.emit()"
            >
              Tour starten
            </button>
          }
          <button class="link-button" type="button" (click)="dismiss.emit()">Später</button>
        </div>
      </section>
    </div>
  `,
  inputs: ['hasProjects', 'afterProject'],
})
export class WelcomeDialogComponent {
  hasProjects = false;
  afterProject = false;
  readonly createProject = output<void>();
  readonly startTour = output<void>();
  readonly dismiss = output<void>();
}
