import { Component, computed, inject, input } from '@angular/core';
import type { DevelopmentItem, Sprint } from '../core/models.js';
import { ProjectStore } from '../core/project-store.js';
import { describeStepEvent } from './step-event.js';

interface ChangedFile {
  path: string;
  url: string | null;
}

/** Web-Adresse des Repositorys aus dem Git-Remote (SSH oder HTTPS), sonst null. */
export function repositoryWebUrl(remote: string | null | undefined): string | null {
  const value = remote?.trim();
  if (!value) return null;
  const ssh = /^git@([\w.-]+):(.+?)(?:\.git)?$/.exec(value);
  if (ssh) return `https://${ssh[1]}/${ssh[2]}`;
  const https = /^https?:\/\/(?:[^@/]+@)?([\w.-]+(?::\d+)?)\/(.+?)(?:\.git)?\/?$/.exec(value);
  return https ? `https://${https[1]}/${https[2]}` : null;
}

/** Dateien, die die Agents eines Auftrags laut Verlauf geschrieben oder bearbeitet haben, mit Link ins Repository. */
@Component({
  selector: 'app-changed-files',
  standalone: true,
  templateUrl: './changed-files.component.html',
})
export class ChangedFilesComponent {
  private readonly store = inject(ProjectStore);
  readonly order = input.required<DevelopmentItem>();
  readonly sprint = input<Sprint | null>(null);

  protected readonly files = computed<ChangedFile[]>(() => {
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
    const base = repositoryWebUrl(this.store.currentProject()?.gitRemote);
    const sprint = this.sprint();
    const ref = sprint?.gitCommit || sprint?.gitBranch || 'main';
    return [...paths].sort().map((path) => ({
      path,
      url:
        base && !path.startsWith('/')
          ? `${base}/blob/${encodeURIComponent(ref)}/${path.split('/').map(encodeURIComponent).join('/')}`
          : null,
    }));
  });
}
