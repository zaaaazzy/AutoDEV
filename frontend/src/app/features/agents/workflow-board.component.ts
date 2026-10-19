import {
  CdkDrag,
  type CdkDragDrop,
  CdkDragPlaceholder,
  CdkDropList,
  CdkDropListGroup,
  moveItemInArray,
  transferArrayItem,
} from '@angular/cdk/drag-drop';
import { Component, computed, inject, input, signal } from '@angular/core';
import { ApiService } from '../../core/api.service.js';
import { AuthService } from '../../core/auth.service.js';
import type { Agent, AgentPhase } from '../../core/models.js';
import { ProjectStore } from '../../core/project-store.js';
import { ModelIconComponent } from '../../shared/model-icon.component.js';
import { AgentSettingsComponent } from './agent-settings.component.js';
import { AGENT_PHASES, modelLabel, roleLabel } from './agent-options.js';
import type { PermissionGroupInfo } from './permission-picker.component.js';

interface Lane {
  id: AgentPhase;
  label: string;
  hint: string;
  agents: Agent[];
}

/**
 * Workflow als Kanban: eine Spalte je Phase (vor dem Sprint … bei abgeschlossen), Karten in Ablauf-Reihenfolge.
 * Ziehen ändert Phase und Reihenfolge (gespeichert in der Datenbank), ein Klick zeigt die Einstellungen des Agents.
 */
@Component({
  selector: 'app-workflow-board',
  standalone: true,
  imports: [CdkDropListGroup, CdkDropList, CdkDrag, CdkDragPlaceholder, ModelIconComponent, AgentSettingsComponent],
  template: `
    <div class="workflow-board kanban" cdkDropListGroup>
      @for (lane of lanes(); track lane.id; let laneIndex = $index) {
        <section class="kanban-column workflow-lane" [class]="'kanban-column workflow-lane lane-' + lane.id">
          <header>
            <strong>{{ laneIndex + 1 }}. {{ lane.label }}</strong>
            <span class="kanban-count">{{ lane.agents.length }}</span>
            <small class="muted">{{ lane.hint }}</small>
          </header>
          <div
            class="kanban-list"
            cdkDropList
            [id]="'workflow-' + lane.id"
            [cdkDropListData]="lane.agents"
            [cdkDropListDisabled]="!editable()"
            (cdkDropListDropped)="drop($event, lane.id)"
          >
            @for (agent of lane.agents; track agent.id; let index = $index) {
              <article
                class="kanban-card workflow-card"
                cdkDrag
                [cdkDragData]="agent"
                [cdkDragDisabled]="!editable()"
                [class.draggable]="editable()"
                [class.disabled]="!agent.enabled"
                [class.selected]="selectedId() === agent.id"
                [class.running]="running().has(agent.id)"
                tabindex="0"
                role="button"
                [attr.aria-label]="'Einstellungen von ' + agent.name"
                (click)="select(agent.id)"
                (keydown.enter)="select(agent.id)"
              >
                <div class="kanban-card-head">
                  <span class="kanban-rank">{{ index + 1 }}</span>
                  <app-model-icon [command]="agent.command" />
                  <strong class="kanban-title">{{ agent.name }}</strong>
                  @if (running().has(agent.id)) {
                    <span class="live-dot" aria-label="arbeitet gerade"></span>
                  }
                </div>
                <div class="kanban-meta">
                  <span class="tag">{{ roleLabel(agent.role) }}</span>
                  <small class="muted">{{ modelLabel(agent.command) }}</small>
                  @if (!agent.enabled) {
                    <span class="tag">deaktiviert</span>
                  }
                </div>
                @if (handoffOf(agent); as target) {
                  <small class="workflow-handoff" title="Nachrichten dieses Agents gehen an">✉ → {{ target }}</small>
                }
                <div class="kanban-placeholder" *cdkDragPlaceholder></div>
              </article>
            } @empty {
              <p class="kanban-empty muted">{{ editable() ? 'Agent hierher ziehen' : 'Kein Agent' }}</p>
            }
          </div>
        </section>
      }
    </div>
    @if (selected(); as agent) {
      <aside class="panel workflow-settings" aria-label="Einstellungen des Agents">
        <button
          type="button"
          class="icon-button workflow-settings-close"
          (click)="selectedId.set(null)"
          aria-label="Schließen"
          title="Schließen"
        >
          ✕
        </button>
        <app-agent-settings [agent]="agent" [groups]="groups()" />
      </aside>
    }
  `,
})
export class WorkflowBoardComponent {
  private readonly api = inject(ApiService);
  private readonly store = inject(ProjectStore);
  private readonly auth = inject(AuthService);

  /** Freigabe-Kategorien des Projekts (für das Einstellungsformular). */
  readonly groups = input<PermissionGroupInfo[]>([]);

  protected readonly roleLabel = roleLabel;
  protected readonly modelLabel = modelLabel;
  protected readonly selectedId = signal<string | null>(null);
  protected readonly editable = computed(() => this.auth.can('agents'));

  protected readonly lanes = computed<Lane[]>(() =>
    AGENT_PHASES.map((phase) => ({
      ...phase,
      agents: this.store
        .data()
        .agents.filter((agent) => agent.phase === phase.id)
        .sort((a, b) => a.position - b.position),
    })),
  );
  protected readonly selected = computed(
    () => this.store.data().agents.find((agent) => agent.id === this.selectedId()) ?? null,
  );
  /** Agents, die laut Worker gerade arbeiten. */
  protected readonly running = computed(
    () =>
      new Set(
        this.store
          .worker()
          .agents.filter((agent) => agent.active)
          .map((agent) => agent.id),
      ),
  );

  protected select(id: string): void {
    this.selectedId.set(this.selectedId() === id ? null : id);
  }

  /** Empfänger der Nachrichten, falls nicht einfach der nächste Agent. */
  protected handoffOf(agent: Agent): string | null {
    if (!agent.handoffTo) return null;
    return this.store.data().agents.find((other) => other.id === agent.handoffTo)?.name ?? null;
  }

  protected async drop(event: CdkDragDrop<Agent[], Agent[], Agent>, phase: AgentPhase): Promise<void> {
    if (event.previousContainer === event.container) {
      if (event.previousIndex === event.currentIndex) return;
      moveItemInArray(event.container.data, event.previousIndex, event.currentIndex);
    } else {
      transferArrayItem(event.previousContainer.data, event.container.data, event.previousIndex, event.currentIndex);
    }
    const ids = event.container.data.map((agent) => agent.id);
    await this.store.perform(
      () => this.api.post(`${this.api.projectPath(this.store.activeProject())}/agents/order`, { phase, ids }),
      event.previousContainer === event.container
        ? 'Reihenfolge gespeichert.'
        : `„${event.item.data.name}“ läuft jetzt in „${AGENT_PHASES.find((entry) => entry.id === phase)?.label}“.`,
    );
  }
}
