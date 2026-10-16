import { Component, inject } from '@angular/core';
import { AgentActivityService } from '../../core/agent-activity.service.js';
import { ApiService } from '../../core/api.service.js';
import { ProjectStore } from '../../core/project-store.js';

/** Laufende und inaktive Agents des Projekts (Kopfzeile und Dashboard). */
@Component({
  selector: 'app-agent-list',
  standalone: true,
  templateUrl: './agent-list.component.html',
  host: { style: 'display: contents' },
})
export class AgentListComponent {
  private readonly api = inject(ApiService);
  protected readonly store = inject(ProjectStore);
  protected readonly activity = inject(AgentActivityService);
  protected readonly worker = this.store.worker;

  protected async cancel(id: string, name: string): Promise<void> {
    if (
      !globalThis.confirm(
        `„${name}“ abbrechen? Der Auftrag wird danach als blockiert markiert und lässt sich erneut starten.`,
      )
    )
      return;
    await this.store.perform(
      () =>
        this.api.post(`${this.api.projectPath(this.store.activeProject())}/agents/${encodeURIComponent(id)}/cancel`),
      `„${name}“ wird abgebrochen.`,
      false,
    );
    globalThis.setTimeout(() => void this.store.refreshWorker(), 2500);
  }
}
