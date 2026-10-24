import { Component, computed, inject, input } from '@angular/core';
import type { DevelopmentItem, Sprint } from '../core/models.js';
import { ProjectStore } from '../core/project-store.js';
import { describeStepEvent } from './step-event.js';
import { FileLinkComponent } from './file-link.component.js';

/** Dateien, die die Agents eines Auftrags laut Verlauf geschrieben oder bearbeitet haben, mit Link ins Repository. */
@Component({
  selector: 'app-changed-files',
  standalone: true,
  imports: [FileLinkComponent],
  templateUrl: './changed-files.component.html',
})
export class ChangedFilesComponent {
  private readonly store = inject(ProjectStore);
  readonly order = input.required<DevelopmentItem>();
  readonly sprint = input<Sprint | null>(null);
  /** Fester Stand für die Links (z. B. der in der Umgebung geladene Commit); sonst der Stand des Sprints. */
  readonly ref = input<string | null>(null);

  protected readonly gitRef = computed(
    () => this.ref() || this.sprint()?.gitCommit || this.sprint()?.gitBranch || null,
  );
  protected readonly files = computed<string[]>(() => {
    const id = this.order().id;
    const paths = new Set<string>();
    for (const run of this.store.data().agentRuns.filter((candidate) => candidate.developmentId === id)) {
      for (const step of run.steps) {
        for (const event of step.events ?? []) {
          const view = describeStepEvent(event.text);
          if (view.kind === 'write' && view.target) paths.add(view.target);
        }
      }
    }
    return [...paths].sort();
  });
}
