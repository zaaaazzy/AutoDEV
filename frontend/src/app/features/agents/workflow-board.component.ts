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
import {
  AGENT_PHASES,
  AGENT_ROLES,
  MODEL_PRESETS,
  modelLabel,
  parseCommand,
  presetLabel,
  roleLabel,
} from './agent-options.js';
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
            @if (editable()) {
              <button
                type="button"
                class="icon-button workflow-add"
                [attr.aria-expanded]="adding() === lane.id"
                [attr.aria-label]="'Karte in „' + lane.label + '“ einfügen'"
                [title]="'Karte in „' + lane.label + '“ einfügen'"
                (click)="toggleAdd(lane.id)"
              >
                +
              </button>
            }
            <small class="muted">{{ lane.hint }}</small>
            @if (adding() === lane.id) {
              <div class="workflow-add-menu" role="dialog" [attr.aria-label]="'Karte in „' + lane.label + '“ einfügen'">
                <h4>Neuer Agent</h4>
                <form
                  (submit)="$event.preventDefault(); createAgent(lane.id, newName.value, newRole.value, newModel.value)"
                >
                  <input #newName name="name" placeholder="Name, z. B. Sicherheitsprüfer" maxlength="80" required />
                  <select #newRole name="role" aria-label="Rolle">
                    @for (role of roles; track role.value) {
                      <option [value]="role.value" [selected]="role.value === 'custom'">{{ role.label }}</option>
                    }
                  </select>
                  <select #newModel name="model" aria-label="Modell">
                    @for (preset of presets; track preset.id) {
                      <option [value]="preset.id">{{ presetLabel(preset) }}</option>
                    }
                  </select>
                  <button class="button primary small" type="submit">Anlegen</button>
                </form>
                @if (existing().length) {
                  <h4>Bestehenden Agent hier einsetzen</h4>
                  <div class="workflow-add-existing">
                    @for (agent of existing(); track agent.id) {
                      <button type="button" (click)="placeCopy(agent, lane.id)">
                        <strong>{{ agent.name }}</strong>
                        <small class="muted"> · {{ roleLabel(agent.role) }} · {{ modelLabel(agent.command) }}</small>
                      </button>
                    }
                  </div>
                }
              </div>
            }
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
                [attr.aria-label]="'Einstellungen von ' + agent.name + (agent.enabled ? '' : ' (deaktiviert)')"
                (click)="select(agent.id)"
                (keydown.enter)="select(agent.id)"
              >
                <!-- Name einmal, Logo rechts daneben auf gleicher Höhe; grüner Punkt nur, solange der Agent arbeitet. -->
                <div class="workflow-card-head">
                  <span class="kanban-rank">{{ index + 1 }}</span>
                  <strong class="kanban-title">{{ agent.name }}</strong>
                  @if (running().has(agent.id)) {
                    <span class="workflow-live" title="arbeitet gerade" aria-label="arbeitet gerade"></span>
                  }
                  <app-model-icon [command]="agent.command" />
                </div>
                <small class="muted workflow-model">{{ modelLabel(agent.command) }}</small>
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
        <app-agent-settings [agent]="agent" [groups]="groups()" [startEditing]="editNext() === agent.id" />
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
  protected readonly roles = AGENT_ROLES;
  protected readonly presets = MODEL_PRESETS;
  protected readonly presetLabel = presetLabel;
  protected readonly selectedId = signal<string | null>(null);
  /** Spalte, deren „+“-Menü offen ist. */
  protected readonly adding = signal<AgentPhase | null>(null);
  /** Frisch angelegter Agent: Einstellungen direkt im Bearbeiten-Modus öffnen. */
  protected readonly editNext = signal<string | null>(null);
  /** Agents, die sich an weiterer Stelle einsetzen lassen (je Name und Rolle einmal). */
  protected readonly existing = computed(() => {
    const seen = new Set<string>();
    return this.store.data().agents.filter((agent) => {
      const key = `${agent.name}|${agent.role}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  });
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

  protected toggleAdd(phase: AgentPhase): void {
    this.adding.set(this.adding() === phase ? null : phase);
  }

  private async create(body: Record<string, unknown>, message: string, edit: boolean): Promise<void> {
    let created: string | null = null;
    await this.store.perform(async () => {
      const result = await this.api.post<{ agent: Agent }>(
        `${this.api.projectPath(this.store.activeProject())}/agents`,
        body,
      );
      created = result.agent.id;
    }, message);
    if (!created) return;
    this.adding.set(null);
    this.editNext.set(edit ? created : null);
    this.selectedId.set(created);
  }

  /** „+“ → Neuer Agent: in dieser Spalte am Ende; danach die Einstellungen zum Verfeinern öffnen. */
  protected async createAgent(phase: AgentPhase, name: string, role: string, model: string): Promise<void> {
    if (!name.trim()) return;
    const preset = MODEL_PRESETS.find((item) => item.id === model);
    await this.create(
      {
        name: name.trim(),
        role,
        phase,
        instructions: '',
        command: preset ? parseCommand(preset.command) : null,
        allowedCommands: [],
      },
      `Agent „${name.trim()}“ angelegt.`,
      true,
    );
  }

  /** „+“ → Bestehenden Agent einsetzen: eigene Karte mit denselben Einstellungen, separat anpassbar. */
  protected async placeCopy(agent: Agent, phase: AgentPhase): Promise<void> {
    await this.create(
      {
        name: agent.name,
        role: agent.role,
        phase,
        instructions: agent.instructions,
        command: agent.command,
        enabled: agent.enabled,
        allowedCommands: agent.allowedCommands ?? null,
        fileScope: agent.fileScope ?? [],
      },
      `„${agent.name}“ zusätzlich in „${AGENT_PHASES.find((entry) => entry.id === phase)?.label}“ eingesetzt.`,
      false,
    );
  }

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
