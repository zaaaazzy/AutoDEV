import { AgentActionsEditorComponent } from './agent-actions-editor.component.js';
import { PermissionPickerComponent, type PermissionGroupInfo } from './permission-picker.component.js';
import { NgClass } from '@angular/common';
import { Component, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AgentActivityService } from '../../core/agent-activity.service.js';
import { ApiService } from '../../core/api.service.js';
import { errorMessage } from '../../core/errors.js';
import type { Agent, AgentPhase } from '../../core/models.js';
import { ProjectStore } from '../../core/project-store.js';
import type { AgentTableRow } from '../../shared/agent-table.component.js';
import { ModelIconComponent } from '../../shared/model-icon.component.js';
import {
  type DataColumn,
  DataCellDirective,
  DataDetailDirective,
  DataTableComponent,
} from '../../shared/data-table/data-table.component.js';
import { statusLabel } from '../../shared/labels.js';
import { StatusClassPipe, StatusLabelPipe } from '../../shared/pipes.js';
import {
  AGENT_PHASES,
  AGENT_ROLES,
  MODEL_PRESETS,
  parseCommand,
  presetLabel,
  presetOf,
  roleLabel,
  modelLabel,
} from './agent-options.js';
import { OrderTableComponent } from '../development/order-table.component.js';
import { AgentDetailComponent } from './agent-detail.component.js';

interface SystemAgent {
  name: string;
  description: string;
  role: string;
  model: string;
  command?: string[] | null;
  envKey: string;
}

interface AgentRow extends AgentTableRow {
  agent: Agent;
  index: number;
  last: boolean;
}

interface SystemRow extends AgentTableRow {
  system: SystemAgent;
}

/** Eine Zeile der gemeinsamen Agent-Tabelle: Workflow-Agent oder System-Agent. */
interface AgentListRow extends AgentTableRow {
  category: string;
  categoryRank: number;
  role: string;
  agent?: Agent;
  index?: number;
  last?: boolean;
  system?: SystemAgent;
}

@Component({
  selector: 'app-agents',
  standalone: true,
  imports: [
    AgentActionsEditorComponent,
    PermissionPickerComponent,
    OrderTableComponent,
    NgClass,
    FormsModule,
    AgentDetailComponent,
    ModelIconComponent,
    DataTableComponent,
    DataCellDirective,
    DataDetailDirective,
    StatusClassPipe,
    StatusLabelPipe,
  ],
  templateUrl: './agents.component.html',
  host: { style: 'display: contents' },
})
export class AgentsComponent {
  private readonly api = inject(ApiService);

  constructor() {
    void this.api
      .get<{ agents: SystemAgent[]; models: string[] }>('/api/system-agents')
      .then((result) => {
        this.systemAgents.set(result.agents);
        this.installedModels.set(result.models);
      })
      .catch(() => undefined);
  }

  protected readonly store = inject(ProjectStore);
  protected readonly activity = inject(AgentActivityService);
  protected readonly data = this.store.data;
  protected readonly busy = this.store.busy;
  protected readonly agentRoles = AGENT_ROLES;
  protected readonly phases = AGENT_PHASES;
  protected readonly roleLabel = roleLabel;
  protected readonly presets = MODEL_PRESETS;
  protected readonly presetLabel = presetLabel;
  protected readonly presetOf = presetOf;

  protected applyPreset(target: { command: string }, id: string): void {
    const preset = MODEL_PRESETS.find((item) => item.id === id);
    if (preset) target.command = preset.command;
  }
  protected readonly systemAgents = signal<SystemAgent[]>([]);
  protected readonly installedModels = signal<string[]>([]);
  protected readonly externalPresets = MODEL_PRESETS.filter((preset) => preset.command);

  protected systemChoice(system: SystemAgent): string {
    const preset = system.command?.length ? presetOf(system.command.join(' ')) : null;
    return preset && preset !== 'custom' ? `preset:${preset}` : `ollama:${system.model}`;
  }

  protected async setSystemChoice(role: string, choice: string): Promise<void> {
    const [kind, value = ''] = [choice.slice(0, choice.indexOf(':')), choice.slice(choice.indexOf(':') + 1)];
    const preset = kind === 'preset' ? MODEL_PRESETS.find((item) => item.id === value) : undefined;
    const command = preset ? parseCommand(preset.command) : null;
    await this.api.put(`/api/system-agents/${role}`, kind === 'ollama' ? { model: value, command: null } : { command });
    this.systemAgents.update((list) =>
      list.map((item) =>
        item.role === role ? { ...item, command, model: kind === 'ollama' ? value : item.model } : item,
      ),
    );
  }
  protected readonly agentEditing = signal<string | null>(null);
  protected agentEdit = { name: '', instructions: '', command: '' };
  /** Kategorien des Projekts (eingebaute und eigene) mit ihren einzelnen Befehlen. */
  protected readonly permissionGroups = signal<PermissionGroupInfo[]>([]);
  /** Neue Agents starten ohne Befehle: jeder wird einzeln freigegeben. */
  protected formCommands: string[] = [];
  protected editCommands: string[] = [];
  protected formScopes: string[] = [];
  protected editScopes: string[] = [];
  private readonly loadGroups = effect(() => {
    const slug = this.store.activeProject();
    if (!slug) return;
    void this.api
      .get<{ groups: PermissionGroupInfo[] }>(`${this.api.projectPath(slug)}/permission-groups`)
      .then((result) => this.permissionGroups.set(result.groups))
      .catch(() => undefined);
  });

  /** Noch nicht festgelegt (null): so, wie der Agent heute läuft – vertraute Rollen mit allen Projektbefehlen. */
  private effectiveCommands(agent: Agent): string[] {
    if (agent.allowedCommands) return [...agent.allowedCommands];
    const available = this.permissionGroups()
      .filter((group) => group.available)
      .flatMap((group) => group.rules);
    return ['assistant', 'developer', 'tester', 'reviewer'].includes(agent.role)
      ? available
      : ['files:create', 'files:edit'];
  }

  protected agentForm = {
    name: '',
    role: 'developer',
    phase: 'while_task' as AgentPhase,
    command: '',
    instructions: '',
  };

  protected agentsOfPhase(phase: AgentPhase): Agent[] {
    return this.data().agents.filter((agent) => agent.phase === phase);
  }

  /** Status: läuft gerade (laut Worker), aktiv oder deaktiviert; darunter Rolle bzw. aktueller Auftrag. */
  protected readonly phaseRows = computed<Partial<Record<AgentPhase, AgentRow[]>>>(() => {
    const live = new Map(this.store.worker().agents.map((entry) => [entry.id, entry]));
    const rows: Partial<Record<AgentPhase, AgentRow[]>> = {};
    for (const phase of AGENT_PHASES) {
      const agents = this.agentsOfPhase(phase.id);
      rows[phase.id] = agents.map((agent, index) => {
        const running = live.get(agent.id)?.active ? live.get(agent.id) : undefined;
        return {
          key: agent.id,
          name: agent.name,
          command: agent.command,
          status: running ? 'running' : agent.enabled ? 'active' : 'inactive',
          hint: running?.orderTitle ? `arbeitet an „${running.orderTitle}“` : null,
          agent,
          index,
          last: index === agents.length - 1,
        };
      });
    }
    return rows;
  });

  /** Alle Agents in einer Tabelle, gruppiert nach Kategorie (Workflow-Phase bzw. System). */
  protected readonly agentRows = computed<AgentListRow[]>(() => [
    ...AGENT_PHASES.flatMap((phase, rank) =>
      (this.phaseRows()[phase.id] ?? []).map((row) => ({
        ...row,
        category: phase.label,
        categoryRank: rank,
        role: roleLabel(row.agent.role),
      })),
    ),
    ...this.systemRows().map((row) => ({
      ...row,
      category: 'System',
      categoryRank: AGENT_PHASES.length,
      role: row.system.description,
    })),
  ]);
  protected readonly agentRowId = (row: AgentListRow): string => row.key;
  protected readonly agentColumns: DataColumn<AgentListRow>[] = [
    { id: 'name', header: 'Agent', value: (row) => row.name, filter: 'text', className: 'title-cell', sortable: false },
    { id: 'category', header: 'Kategorie', value: (row) => row.category, sortValue: (row) => row.categoryRank },
    { id: 'model', header: 'Modell', value: (row) => modelLabel(row.command, row.system?.model) },
    { id: 'status', header: 'Status', value: (row) => statusLabel(row.status) },
  ];

  /** Aufträge mit Agent-Läufen, der zuletzt bearbeitete zuerst. */
  protected readonly recentOrders = computed(() => {
    const lastRun = new Map<string, string>();
    for (const run of this.data().agentRuns) {
      if (!run.developmentId) continue;
      const seen = lastRun.get(run.developmentId);
      if (!seen || run.startedAt > seen) lastRun.set(run.developmentId, run.startedAt);
    }
    return this.data()
      .development.filter((item) => lastRun.has(item.id))
      .sort((a, b) => lastRun.get(b.id)!.localeCompare(lastRun.get(a.id)!))
      .slice(0, 20);
  });

  protected readonly systemRows = computed<SystemRow[]>(() =>
    this.systemAgents().map((system) => ({
      key: system.role,
      name: system.name,
      command: system.command,
      status:
        system.role === 'assistant' &&
        this.store.worker().agents.some((agent) => agent.id === 'assistant' && agent.active)
          ? 'running'
          : 'active',
      hint: null,
      system,
    })),
  );

  protected startAgentEdit(agent: Agent): void {
    this.agentEdit = { name: agent.name, instructions: agent.instructions, command: agent.command?.join(' ') ?? '' };
    this.editCommands = this.effectiveCommands(agent);
    this.editScopes = [...(agent.fileScope ?? [])];
    this.agentEditing.set(agent.id);
  }

  protected async createAgent(): Promise<void> {
    let command: string[] | null;
    try {
      command = parseCommand(this.agentForm.command);
    } catch (error) {
      this.store.notice.set(errorMessage(error, 'Der Agent-Befehl ist ungültig.'));
      return;
    }
    await this.store.perform(async () => {
      await this.api.post(`${this.api.projectPath(this.store.activeProject())}/agents`, {
        ...this.agentForm,
        command,
        allowedCommands: this.formCommands,
        fileScope: this.formScopes,
      });
      this.agentForm = { name: '', role: 'developer', phase: 'while_task', command: '', instructions: '' };
      this.formCommands = [];
      this.formScopes = [];
      this.store.showCreate.set(false);
    }, 'Agent angelegt.');
  }

  protected async createDefaultAgents(): Promise<void> {
    await this.store.perform(
      () => this.api.post(`${this.api.projectPath(this.store.activeProject())}/agents/defaults`),
      'Standard-Workflow angelegt.',
    );
  }

  protected async updateAgent(id: string, values: Partial<Agent>): Promise<void> {
    await this.store.perform(
      () => this.api.patch(`/api/agents/${encodeURIComponent(id)}`, values),
      'Agent aktualisiert.',
    );
  }

  protected async saveAgentEdit(agent: Agent): Promise<void> {
    let command: string[] | null;
    try {
      command = parseCommand(this.agentEdit.command);
    } catch (error) {
      this.store.notice.set(errorMessage(error, 'Der Agent-Befehl ist ungültig.'));
      return;
    }
    await this.updateAgent(agent.id, {
      name: this.agentEdit.name,
      instructions: this.agentEdit.instructions,
      command,
      allowedCommands: this.editCommands,
      fileScope: this.editScopes,
    });
    this.agentEditing.set(null);
  }

  protected async deleteAgent(id: string): Promise<void> {
    if (!globalThis.confirm('Agent löschen?')) return;
    await this.store.perform(() => this.api.delete(`/api/agents/${encodeURIComponent(id)}`), 'Agent gelöscht.');
  }

  protected async moveAgent(agent: Agent, direction: -1 | 1): Promise<void> {
    const ids = this.data()
      .agents.filter((item) => item.phase === agent.phase)
      .map((item) => item.id);
    const index = ids.indexOf(agent.id);
    const nextIndex = index + direction;
    if (index < 0 || nextIndex < 0 || nextIndex >= ids.length) return;
    [ids[index], ids[nextIndex]] = [ids[nextIndex]!, ids[index]!];
    await this.store.perform(
      () =>
        this.api.post(`${this.api.projectPath(this.store.activeProject())}/agents/order`, {
          phase: agent.phase,
          ids,
        }),
      'Reihenfolge gespeichert.',
    );
  }
}
