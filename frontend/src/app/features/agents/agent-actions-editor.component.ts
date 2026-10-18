import { NgTemplateOutlet } from '@angular/common';
import { Component, computed, inject, input, signal } from '@angular/core';
import { type AgentAction, AgentActionsService } from '../../core/agent-actions.service.js';

/** Aktionen eines Agents (Quick Actions): ansehen, starten, anlegen, ändern, löschen – direkt beim Agent. */
@Component({
  selector: 'app-agent-actions-editor',
  standalone: true,
  template: `
    <div class="agent-actions-editor">
      <span class="permission-title"
        >Aktionen <small class="muted">– erscheinen im Dashboard als Quick Actions</small></span
      >
      <ul class="agent-action-list">
        @for (action of mine(); track action.id) {
          <li>
            @if (editing() === action.id) {
              <ng-container *ngTemplateOutlet="form; context: { $implicit: action }" />
            } @else {
              <span class="agent-action-text" [title]="action.prompt">
                <strong>{{ action.title }}</strong>
                <small class="muted">{{ action.prompt }}</small>
              </span>
              <button
                type="button"
                class="agent-task-icon"
                title="Starten"
                aria-label="Starten"
                (click)="actions.run(action)"
              >
                ▶
              </button>
              <button
                type="button"
                class="agent-task-icon"
                title="Bearbeiten"
                aria-label="Bearbeiten"
                (click)="editing.set(action.id)"
              >
                ✎
              </button>
              <button
                type="button"
                class="agent-task-icon"
                title="Löschen"
                aria-label="Löschen"
                (click)="actions.remove(action)"
              >
                ✕
              </button>
            }
          </li>
        } @empty {
          <li class="muted small">Noch keine Aktionen.</li>
        }
      </ul>
      @if (editing() === 'new') {
        <ng-container *ngTemplateOutlet="form; context: { $implicit: null }" />
      } @else {
        <button type="button" class="agent-tasks-new" (click)="editing.set('new')">+ Aktion für diesen Agent</button>
      }
    </div>
    <ng-template #form let-action>
      <div class="agent-action-form">
        <input
          #title
          [value]="action?.title ?? ''"
          maxlength="120"
          placeholder="Titel, z. B. Tests ausführen"
          aria-label="Titel der Aktion"
        />
        <textarea
          #prompt
          rows="3"
          maxlength="3500"
          placeholder="Was soll der Agent tun?"
          aria-label="Anweisung der Aktion"
          >{{ action?.prompt ?? '' }}</textarea>
        <span class="agent-task-actions">
          <button
            class="button primary small"
            type="button"
            [disabled]="actions.busy()"
            (click)="save(action, title.value, prompt.value)"
          >
            Speichern
          </button>
          <button class="button secondary small" type="button" (click)="editing.set(null)">Abbrechen</button>
        </span>
      </div>
    </ng-template>
  `,
  imports: [NgTemplateOutlet],
})
export class AgentActionsEditorComponent {
  protected readonly actions = inject(AgentActionsService);
  readonly agentId = input.required<string>();
  /** 'new' = neue Aktion, sonst die ID der bearbeiteten Aktion. */
  protected readonly editing = signal<string | null>(null);
  protected readonly mine = computed(() => this.actions.byAgent().get(this.agentId()) ?? []);

  protected async save(action: AgentAction | null, title: string, prompt: string): Promise<void> {
    const saved = await this.actions.save({ id: action?.id ?? null, title, prompt, agentId: this.agentId() });
    if (saved) this.editing.set(null);
  }
}
