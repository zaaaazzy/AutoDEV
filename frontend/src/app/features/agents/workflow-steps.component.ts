import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../core/api.service.js';
import { AuthService } from '../../core/auth.service.js';
import { errorMessage } from '../../core/errors.js';
import type { Agent, AgentPhase, WorkflowStep } from '../../core/models.js';
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

/**
 * Workflow als aufklappbare Karte: für jeden Zeitpunkt (Sprintstart, vor/während/nach dem Auftrag, abgelehnt,
 * abgeschlossen) die Agents, die dann laufen – eingerückt, in Ablauf-Reihenfolge. Mit „+ Agent“ lässt sich jeder
 * Agent hinzufügen, auch mehrfach; jeder Eintrag hat eine eigene Anweisung für genau diesen Einsatz.
 */
@Component({
  selector: 'app-workflow-steps',
  standalone: true,
  imports: [FormsModule, ModelIconComponent, AgentSettingsComponent],
  template: `
    <details class="panel workflow-panel" [open]="expanded()" (toggle)="onToggle($event)">
      <summary class="workflow-summary">
        <span class="chev" [class.open]="expanded()" aria-hidden="true">▸</span>
        <span class="workflow-summary-text">
          <h2>Workflow</h2>
          <span class="muted"
            >Für jeden Zeitpunkt festlegen, welche Agents laufen – mit „+ Agent“ auch mehrfach, jeweils mit eigener
            Anweisung.</span
          >
        </span>
        <span class="kanban-count">{{ steps().length }}</span>
      </summary>
      @for (phase of phases; track phase.id; let phaseIndex = $index) {
        <section class="workflow-phase" [class]="'workflow-phase phase-' + phase.id">
          <header class="workflow-phase-head">
            <span class="workflow-phase-number">{{ phaseIndex + 1 }}</span>
            <span class="workflow-phase-title">
              <strong>{{ phase.label }}</strong>
              <small class="muted">{{ phase.hint }}</small>
            </span>
            @if (editable()) {
              <button
                type="button"
                class="button secondary small"
                [attr.aria-expanded]="adding() === phase.id"
                (click)="toggleAdd(phase.id)"
              >
                + Agent
              </button>
            }
          </header>
          <ol class="workflow-steps">
            @for (step of stepsOf(phase.id); track step.id; let index = $index; let last = $last) {
              @let agent = agentOf(step);
              <li class="workflow-step" [class.disabled]="!step.enabled || !agent?.enabled">
                <div class="workflow-step-head">
                  <span class="kanban-rank">{{ index + 1 }}</span>
                  <strong class="workflow-step-name">{{ agent?.name ?? 'Agent gelöscht' }}</strong>
                  @if (agent && running().has(agent.id)) {
                    <span class="workflow-live" title="arbeitet gerade" aria-label="arbeitet gerade"></span>
                  }
                  <app-model-icon [command]="agent?.command ?? null" />
                </div>
                @if (editingStep() === step.id) {
                  <form class="workflow-step-edit" (ngSubmit)="saveInstructions(step)">
                    <label
                      >Anweisung für diesen Schritt
                      <textarea
                        name="instructions"
                        [(ngModel)]="draft"
                        rows="4"
                        maxlength="10000"
                        placeholder="z. B. „Prüfe nur die API, die Oberfläche testet der nächste Schritt.“"
                      ></textarea>
                    </label>
                    <small class="muted"
                      >Gilt zusätzlich zur Anweisung des Agents und hat bei Widerspruch Vorrang.</small
                    >
                    <div class="actions">
                      <button class="button primary small" type="submit" [disabled]="store.busy()">Speichern</button>
                      <button class="button secondary small" type="button" (click)="editingStep.set(null)">
                        Abbrechen
                      </button>
                    </div>
                  </form>
                } @else {
                  <p class="workflow-step-instruction" [class.muted]="!step.instructions">
                    {{ step.instructions || 'Keine eigene Anweisung – es gilt die Anweisung des Agents.' }}
                  </p>
                  @if (agent && !agent.enabled) {
                    <small class="workflow-step-instruction"
                      >Der Agent ist in seinen Einstellungen deaktiviert und läuft hier nicht mit.</small
                    >
                  } @else if (!step.enabled) {
                    <small class="workflow-step-instruction">Pausiert – läuft hier nicht mit.</small>
                  }
                }
                @if (editable() && editingStep() !== step.id) {
                  <div class="workflow-step-actions">
                    <button type="button" class="link-button" (click)="startInstructions(step)">✎ Anweisung</button>
                    <button
                      type="button"
                      class="icon-button"
                      [disabled]="index === 0 || store.busy()"
                      (click)="move(step, -1)"
                      aria-label="Nach oben"
                      title="Nach oben"
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      class="icon-button"
                      [disabled]="last || store.busy()"
                      (click)="move(step, 1)"
                      aria-label="Nach unten"
                      title="Nach unten"
                    >
                      ↓
                    </button>
                    <button type="button" class="link-button" (click)="toggleEnabled(step)">
                      {{ step.enabled ? 'Pausieren' : 'Aktivieren' }}
                    </button>
                    @if (agent) {
                      <button type="button" class="link-button" (click)="toggleSettings(step.id)">
                        {{ settingsFor() === step.id ? 'Agent-Einstellungen schließen' : 'Agent-Einstellungen' }}
                      </button>
                    }
                    <button type="button" class="link-button danger" (click)="remove(step, agent)">Entfernen</button>
                  </div>
                }
                @if (settingsFor() === step.id && agent) {
                  <div class="workflow-step-settings">
                    <app-agent-settings [agent]="agent" [groups]="groups()" />
                  </div>
                }
              </li>
            } @empty {
              <li class="workflow-empty muted">Kein Agent – mit „+ Agent“ hinzufügen.</li>
            }
            @if (adding() === phase.id) {
              <li class="workflow-add-panel">
                <strong>Agent hinzufügen</strong>
                <div class="workflow-add-existing">
                  @for (agent of store.data().agents; track agent.id) {
                    <button type="button" [disabled]="store.busy()" (click)="addStep(phase.id, agent.id)">
                      <app-model-icon [command]="agent.command" />
                      <span
                        ><strong>{{ agent.name }}</strong>
                        <small class="muted">{{ roleLabel(agent.role) }} · {{ modelLabel(agent.command) }}</small></span
                      >
                    </button>
                  }
                </div>
                <form
                  class="workflow-add-new"
                  (submit)="
                    $event.preventDefault(); createAgent(phase.id, newName.value, newRole.value, newModel.value)
                  "
                >
                  <strong>… oder neuen Agent anlegen</strong>
                  <input #newName name="name" placeholder="Name, z. B. Sicherheitsprüfer" maxlength="80" required />
                  <select #newRole name="role" aria-label="Rolle" [disabled]="!auth.can('admin')">
                    @for (role of roles; track role.value) {
                      <option [value]="role.value" [selected]="role.value === 'custom'">{{ role.label }}</option>
                    }
                  </select>
                  <select #newModel name="model" aria-label="Modell" [disabled]="!auth.can('admin')">
                    @for (preset of presets; track preset.id) {
                      <option [value]="preset.id">{{ presetLabel(preset) }}</option>
                    }
                  </select>
                  <div class="actions">
                    <button class="button primary small" type="submit" [disabled]="store.busy()">Anlegen</button>
                    <button class="button secondary small" type="button" (click)="adding.set(null)">Abbrechen</button>
                  </div>
                </form>
              </li>
            }
          </ol>
        </section>
      }
    </details>
  `,
})
export class WorkflowStepsComponent {
  private readonly api = inject(ApiService);
  protected readonly store = inject(ProjectStore);
  protected readonly auth = inject(AuthService);

  /** Freigabe-Kategorien des Projekts (für die Agent-Einstellungen). */
  readonly groups = input<PermissionGroupInfo[]>([]);

  protected readonly phases = AGENT_PHASES;
  protected readonly roles = AGENT_ROLES;
  protected readonly presets = MODEL_PRESETS;
  protected readonly presetLabel = presetLabel;
  protected readonly roleLabel = roleLabel;
  protected readonly modelLabel = modelLabel;
  protected readonly editable = computed(() => this.auth.can('agents'));
  protected readonly steps = signal<WorkflowStep[]>([]);
  protected readonly expanded = signal(this.readExpanded());
  protected readonly adding = signal<AgentPhase | null>(null);
  protected readonly editingStep = signal<string | null>(null);
  protected readonly settingsFor = signal<string | null>(null);
  protected draft = '';

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

  /** Ändert sich nur, wenn Agents dazukommen oder wegfallen – nicht bei jeder Live-Aktualisierung. */
  private readonly agentIds = computed(() =>
    this.store
      .data()
      .agents.map((agent) => agent.id)
      .join(','),
  );

  constructor() {
    effect(() => {
      const slug = this.store.activeProject();
      this.agentIds();
      if (slug) void this.load(slug);
    });
  }

  private readExpanded(): boolean {
    try {
      return globalThis.localStorage?.getItem('devlog.workflow.open') !== '0';
    } catch {
      return true;
    }
  }

  protected onToggle(event: Event): void {
    const open = (event.target as HTMLDetailsElement).open;
    this.expanded.set(open);
    try {
      globalThis.localStorage?.setItem('devlog.workflow.open', open ? '1' : '0');
    } catch {
      /* ohne Speicher bleibt es beim Standard */
    }
  }

  private path(): string {
    return `${this.api.projectPath(this.store.activeProject())}/workflow`;
  }

  private async load(slug = this.store.activeProject()): Promise<void> {
    try {
      const { steps } = await this.api.get<{ steps: WorkflowStep[] }>(`${this.api.projectPath(slug)}/workflow`);
      if (slug === this.store.activeProject()) this.steps.set(steps);
    } catch (error) {
      this.store.notice.set(errorMessage(error, 'Workflow konnte nicht geladen werden.'));
    }
  }

  protected stepsOf(phase: AgentPhase): WorkflowStep[] {
    return this.steps()
      .filter((step) => step.phase === phase)
      .sort((a, b) => a.position - b.position);
  }

  protected agentOf(step: WorkflowStep): Agent | undefined {
    return this.store.data().agents.find((agent) => agent.id === step.agentId);
  }

  protected toggleAdd(phase: AgentPhase): void {
    this.adding.set(this.adding() === phase ? null : phase);
  }

  protected toggleSettings(id: string): void {
    this.settingsFor.set(this.settingsFor() === id ? null : id);
  }

  /** Änderung ausführen, Meldung zeigen und den Workflow neu laden. */
  private async change(action: () => Promise<unknown>, message: string): Promise<void> {
    await this.store.perform(action, message, false);
    await this.load();
  }

  protected async addStep(phase: AgentPhase, agentId: string, editInstructions = true): Promise<void> {
    let created: WorkflowStep | null = null;
    await this.change(async () => {
      created = (await this.api.post<{ step: WorkflowStep }>(`${this.path()}/steps`, { phase, agentId })).step;
    }, 'Agent zum Workflow hinzugefügt.');
    this.adding.set(null);
    // Gleich die Anweisung für diesen Einsatz anbieten.
    if (created && editInstructions) this.startInstructions(created);
  }

  /** Neuer Agent: anlegen und direkt in diese Phase setzen. */
  protected async createAgent(phase: AgentPhase, name: string, role: string, model: string): Promise<void> {
    if (!name.trim()) return;
    const preset = MODEL_PRESETS.find((item) => item.id === model);
    let agentId: string | null = null;
    await this.store.perform(async () => {
      const result = await this.api.post<{ agent: Agent }>(
        `${this.api.projectPath(this.store.activeProject())}/agents`,
        {
          name: name.trim(),
          // Rolle und Befehl setzt nur die Administration; sonst entsteht ein eigener Agent ohne Befehl.
          ...(this.auth.can('admin') ? { role, command: preset ? parseCommand(preset.command) : null } : {}),
          phase,
          instructions: '',
          allowedCommands: [],
        },
      );
      agentId = result.agent.id;
    }, `Agent „${name.trim()}“ angelegt.`);
    if (agentId) await this.addStep(phase, agentId);
  }

  protected startInstructions(step: WorkflowStep): void {
    this.draft = step.instructions;
    this.editingStep.set(step.id);
  }

  protected async saveInstructions(step: WorkflowStep): Promise<void> {
    await this.change(
      () => this.api.patch(`/api/workflow-steps/${encodeURIComponent(step.id)}`, { instructions: this.draft }),
      'Anweisung gespeichert.',
    );
    this.editingStep.set(null);
  }

  protected async toggleEnabled(step: WorkflowStep): Promise<void> {
    await this.change(
      () => this.api.patch(`/api/workflow-steps/${encodeURIComponent(step.id)}`, { enabled: !step.enabled }),
      step.enabled ? 'Schritt pausiert – er läuft nicht mehr mit.' : 'Schritt wieder aktiv.',
    );
  }

  protected async move(step: WorkflowStep, direction: -1 | 1): Promise<void> {
    const ids = this.stepsOf(step.phase).map((entry) => entry.id);
    const index = ids.indexOf(step.id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target]!, ids[index]!];
    await this.change(
      () => this.api.post(`${this.path()}/order`, { phase: step.phase, ids }),
      'Reihenfolge gespeichert.',
    );
  }

  protected async remove(step: WorkflowStep, agent: Agent | undefined): Promise<void> {
    if (
      !globalThis.confirm(`„${agent?.name ?? 'Agent'}“ aus diesem Schritt entfernen? Der Agent selbst bleibt erhalten.`)
    )
      return;
    await this.change(
      () => this.api.delete(`/api/workflow-steps/${encodeURIComponent(step.id)}`),
      'Aus dem Workflow entfernt.',
    );
  }
}
