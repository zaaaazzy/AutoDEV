import { Component, computed, inject, input } from '@angular/core';
import { AgentActivityService } from '../../core/agent-activity.service.js';
import { ApiService } from '../../core/api.service.js';
import { ProjectStore } from '../../core/project-store.js';
import { RoleIconComponent } from '../../shared/role-icon.component.js';
import { agentRights, agentRole, agentRoleLabel, rightsTexts } from './agent-options.js';

/** Laufende und inaktive Agents des Projekts (Kopfzeile und Dashboard). */
@Component({
  selector: 'app-agent-list',
  standalone: true,
  imports: [RoleIconComponent],
  templateUrl: './agent-list.component.html',
  host: { style: 'display: contents' },
})
export class AgentListComponent {
  private readonly api = inject(ApiService);
  protected readonly store = inject(ProjectStore);
  protected readonly activity = inject(AgentActivityService);
  protected readonly worker = this.store.worker;
  /** Dashboard: zusätzlich Rollen-Icon, Rolle und Rechte-Stufe je Agent. */
  readonly details = input(false);

  /** Agents mit Rolle, Rechten und Aufgabentext; Rechte kommen nur aus `agent-options.ts`. */
  protected readonly agents = computed(() => {
    const online = this.worker().online;
    return this.worker().agents.map((agent) => ({
      ...agent,
      roleKey: agentRole(agent.role),
      roleLabel: agentRoleLabel(agent.role),
      rights: agentRights(agent.role),
      rightsText: rightsTexts(agent.role),
      task: agent.active
        ? (agent.sprintName ? agent.sprintName + ' - ' : '') + agent.orderTitle
        : agent.waiting
          ? `wartet · ${agent.orderTitle ?? 'Rückfrage'}`
          : online
            ? 'Inaktiv'
            : 'Worker offline',
    }));
  });
  /** Der Dashboard-Assistent hat keine Agent-Aktivität, sondern arbeitet im Chat des Dashboards. */
  protected readonly assistantId = 'assistant';
  /** Der Visionär arbeitet in Ideation (Fortschritt, Abbrechen, neue Ideen). */
  protected readonly visionaryId = 'visionary';

  protected open(id: string): void {
    if (id === this.assistantId) this.store.navigate('dashboard');
    else if (id === this.visionaryId) this.store.navigate('ideation');
    else this.activity.show(id);
  }

  protected async cancel(id: string, name: string): Promise<void> {
    if (
      !globalThis.confirm(
        id === this.visionaryId
          ? 'Visionär-Lauf abbrechen? Aus diesem Lauf werden dann keine Ideen angelegt.'
          : `„${name}“ abbrechen? Der Auftrag wird danach als blockiert markiert und lässt sich erneut starten.`,
      )
    )
      return;
    const project = this.api.projectPath(this.store.activeProject());
    await this.store.perform(
      () =>
        this.api.post(
          id === this.visionaryId
            ? `${project}/ideation/visionary/cancel`
            : `${project}/agents/${encodeURIComponent(id)}/cancel`,
        ),
      `„${name}“ wird abgebrochen.`,
      false,
    );
    globalThis.setTimeout(() => void this.store.refreshWorker(), 2500);
  }
}
