import { NgClass } from '@angular/common';
import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AgentActivityService } from '../../core/agent-activity.service.js';
import { ApiService } from '../../core/api.service.js';
import { errorMessage } from '../../core/errors.js';
import type { Agent, AgentPhase } from '../../core/models.js';
import { ProjectStore } from '../../core/project-store.js';
import { ModelIconComponent } from '../../shared/model-icon.component.js';
import { AgentOutputPipe } from '../../shared/agent-output.pipe.js';
import { DateTimePipe, StatusClassPipe, StatusLabelPipe } from '../../shared/pipes.js';
import {
  AGENT_PHASES,
  AGENT_ROLES,
  MODEL_PRESETS,
  parseCommand,
  presetLabel,
  presetOf,
  roleLabel,
} from './agent-options.js';
import { AgentDetailComponent } from './agent-detail.component.js';

interface SystemAgent {
  name: string;
  description: string;
  role: string;
  model: string;
  command?: string[] | null;
  envKey: string;
}

@Component({
  selector: 'app-agents',
  standalone: true,
  imports: [
    NgClass,
    FormsModule,
    AgentDetailComponent,
    ModelIconComponent,
    AgentOutputPipe,
    DateTimePipe,
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

  /** A stored command that matches no preset stays visible as "custom" so the UI never hides an active CLI. */
  protected systemChoice(system: SystemAgent): string {
    if (!system.command?.length) return `ollama:${system.model}`;
    const preset = presetOf(system.command.join(' '));
    return preset === 'custom' ? 'custom:' : `preset:${preset}`;
  }

  protected async setSystemChoice(role: string, choice: string): Promise<void> {
    if (choice === 'custom:') return;
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

  protected startAgentEdit(agent: Agent): void {
    this.agentEdit = { name: agent.name, instructions: agent.instructions, command: agent.command?.join(' ') ?? '' };
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
      });
      this.agentForm = { name: '', role: 'developer', phase: 'while_task', command: '', instructions: '' };
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
    await this.updateAgent(agent.id, { name: this.agentEdit.name, instructions: this.agentEdit.instructions, command });
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
