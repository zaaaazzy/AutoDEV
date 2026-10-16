import { NgClass } from '@angular/common';
import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AgentActivityService } from '../../core/agent-activity.service.js';
import { ApiService } from '../../core/api.service.js';
import { errorMessage } from '../../core/errors.js';
import type { Agent, AgentPhase } from '../../core/models.js';
import { ProjectStore } from '../../core/project-store.js';
import { ModelIconComponent } from '../../shared/model-icon.component.js';
import { MarkdownPipe } from '../../shared/markdown.pipe.js';
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

@Component({
  selector: 'app-agents',
  standalone: true,
  imports: [
    NgClass,
    FormsModule,
    AgentDetailComponent,
    ModelIconComponent,
    MarkdownPipe,
    DateTimePipe,
    StatusClassPipe,
    StatusLabelPipe,
  ],
  templateUrl: './agents.component.html',
  host: { style: 'display: contents' },
})
export class AgentsComponent {
  private readonly api = inject(ApiService);
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
