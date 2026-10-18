import { Component, computed, inject } from '@angular/core';
import { AgentActionsService } from '../../core/agent-actions.service.js';
import { AuthService } from '../../core/auth.service.js';
import { ProjectStore } from '../../core/project-store.js';
import { NavIconComponent } from '../../shared/nav-icon.component.js';

/** Quick Actions: die Aktionen der Agents als Knöpfe, gruppiert nach Agent; ein Klick startet sie. */
@Component({
  selector: 'app-quick-actions',
  standalone: true,
  imports: [NavIconComponent],
  template: `
    @if (groups().length) {
      <section class="panel quick-actions" aria-label="Quick Actions">
        <div class="section-heading">
          <h2>Quick Actions</h2>
          <a href="#agents" (click)="$event.preventDefault(); store.navigate('agents')">Aktionen verwalten</a>
        </div>
        @for (group of groups(); track group.id) {
          <div class="quick-group">
            <span class="quick-agent"
              ><span class="mention-icon" aria-hidden="true"><app-nav-icon name="agents" /></span>{{ group.name }}</span
            >
            <div class="quick-buttons">
              @for (action of group.actions; track action.id) {
                <button
                  type="button"
                  class="quick-button"
                  [title]="action.prompt"
                  [disabled]="actions.busy() || !auth.can('chat')"
                  (click)="actions.run(action)"
                >
                  ▶ {{ action.title }}
                </button>
              }
            </div>
          </div>
        }
      </section>
    }
  `,
  host: { style: 'display: contents' },
})
export class QuickActionsComponent {
  protected readonly store = inject(ProjectStore);
  protected readonly auth = inject(AuthService);
  protected readonly actions = inject(AgentActionsService);

  /** Je Agent (in Workflow-Reihenfolge) seine Aktionen; Aktionen ohne Agent gehören dem Assistenten. */
  protected readonly groups = computed(() => {
    const byAgent = this.actions.byAgent();
    const agents = this.store.data().agents.filter((agent) => byAgent.has(agent.id));
    const groups = agents.map((agent) => ({ id: agent.id, name: agent.name, actions: byAgent.get(agent.id)! }));
    const general = byAgent.get('');
    return general?.length ? [...groups, { id: 'assistant', name: 'Assistent', actions: general }] : groups;
  });
}
