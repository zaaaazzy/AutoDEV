import { Component, computed, ElementRef, inject, input, output, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../core/api.service.js';
import { AuthService } from '../../core/auth.service.js';
import { errorMessage } from '../../core/errors.js';
import type { Agent } from '../../core/models.js';
import { ProjectStore } from '../../core/project-store.js';
import { ModelIconComponent } from '../../shared/model-icon.component.js';
import { AgentActionsEditorComponent } from './agent-actions-editor.component.js';
import {
  MODEL_PRESETS,
  modelLabel,
  parseCommand,
  phaseLabel,
  presetLabel,
  presetOf,
  roleLabel,
} from './agent-options.js';
import { PermissionPickerComponent, type PermissionGroupInfo } from './permission-picker.component.js';

/**
 * Einstellungen eines Workflow-Agents: zuerst lesend, mit ✎ bearbeitbar. Dasselbe Formular nutzen die Agent-Tabelle
 * und das Workflow-Board.
 */
@Component({
  selector: 'app-agent-settings',
  standalone: true,
  imports: [FormsModule, ModelIconComponent, PermissionPickerComponent, AgentActionsEditorComponent],
  template: `
    @let current = agent();
    @if (!editing()) {
      <div class="agent-settings">
        <header class="agent-settings-head">
          <app-model-icon [command]="current.command" />
          <div>
            <strong>{{ current.name }}</strong>
            <small class="muted">{{ roleLabel(current.role) }} · {{ phaseLabel(current.phase) }}</small>
          </div>
          @if (auth.can('agents')) {
            <button type="button" class="button secondary small" (click)="startEdit()" title="Einstellungen bearbeiten">
              ✎ Bearbeiten
            </button>
          }
        </header>
        <!-- Anweisung zuerst und gut sichtbar: Das ist, was der Agent tun soll. -->
        <section class="agent-settings-instructions">
          <h4>Anweisung</h4>
          <p class="detail-text">{{ current.instructions || 'Keine Anweisung hinterlegt.' }}</p>
          @if (auth.can('agents')) {
            <button type="button" class="button secondary small" (click)="startEdit(true)">
              ✎ Anweisung bearbeiten
            </button>
          }
        </section>
        <dl class="agent-settings-list">
          <dt>Status</dt>
          <dd>{{ current.enabled ? 'Aktiv' : 'Deaktiviert' }}</dd>
          <dt>Modell</dt>
          <dd>{{ modelLabel(current.command) }}</dd>
          <dt>Befehl</dt>
          <dd>
            <code>{{ current.command?.join(' ') || 'Eingebauter Agent (lokales Modell)' }}</code>
          </dd>
          <dt>Nachricht geht an</dt>
          <dd>{{ handoffName() }}</dd>
          <dt>Rechte</dt>
          <dd>
            {{
              current.allowedCommands
                ? current.allowedCommands.length + ' einzeln freigegeben'
                : 'Projektstandard der Rolle'
            }}{{ current.fileScope?.length ? ' · nur in ' + current.fileScope!.join(', ') : '' }}
          </dd>
        </dl>
        @if (auth.can('agents')) {
          <!-- Aktionen (Aufgaben mit eigener Anweisung) direkt bedienbar, nicht erst im Bearbeiten-Modus. -->
          <app-agent-actions-editor [agentId]="current.id" />
        }
      </div>
    } @else {
      <form class="form-grid" (ngSubmit)="save()">
        <label class="wide">Name<input name="name" [(ngModel)]="form.name" maxlength="80" required /></label>
        <label class="wide"
          >Verhalten (Anweisung)<textarea
            #instructionsField
            name="instructions"
            [(ngModel)]="form.instructions"
            rows="6"
            maxlength="10000"
          ></textarea>
        </label>
        <label
          >Modell<select
            name="preset"
            [ngModel]="presetOf(form.command)"
            (ngModelChange)="applyPreset($event)"
            [disabled]="!auth.can('admin')"
          >
            @for (preset of presets; track preset.id) {
              <option [value]="preset.id">{{ presetLabel(preset) }}</option>
            }
            <option value="custom">Eigener Befehl …</option>
          </select>
        </label>
        <label
          >Befehl (leer = eingebauter Agent)<input
            name="command"
            [(ngModel)]="form.command"
            maxlength="1000"
            placeholder="claude -p"
            [disabled]="!auth.can('admin')"
            [title]="auth.can('admin') ? '' : 'Modell und Befehl ändert nur die Administration.'"
          />
        </label>
        <label class="wide"
          >Nachricht geht an
          <select name="handoff" [(ngModel)]="form.handoffTo">
            <option [ngValue]="null">Nächster Agent im Workflow</option>
            @for (other of otherAgents(); track other.id) {
              <option [ngValue]="other.id">{{ other.name }} ({{ phaseLabel(other.phase) }})</option>
            }
          </select>
          <small class="muted"
            >Mit einer Zeile „&#64;&#64;NACHRICHT: …“ gibt der Agent eine Nachricht weiter; „&#64;&#64;NACHRICHT an
            Name: …“ wählt den Empfänger selbst.</small
          >
        </label>
        <app-permission-picker class="wide" [groups]="groups()" [(selected)]="commands" [(scopes)]="scopes" />
        <div class="actions wide form-actions">
          <button class="button primary" type="submit" [disabled]="store.busy()">Speichern</button>
          <button class="button secondary" type="button" (click)="cancel()">Abbrechen</button>
        </div>
      </form>
    }
  `,
})
export class AgentSettingsComponent {
  private readonly api = inject(ApiService);
  protected readonly store = inject(ProjectStore);
  protected readonly auth = inject(AuthService);

  readonly agent = input.required<Agent>();
  /** Freigabe-Kategorien des Projekts (für die Rechte-Auswahl). */
  readonly groups = input<PermissionGroupInfo[]>([]);
  readonly saved = output<void>();

  protected readonly editing = signal(false);
  protected readonly presets = MODEL_PRESETS;
  protected readonly presetLabel = presetLabel;
  protected readonly presetOf = presetOf;
  protected readonly roleLabel = roleLabel;
  protected readonly phaseLabel = phaseLabel;
  protected readonly modelLabel = modelLabel;
  protected form = { name: '', instructions: '', command: '', handoffTo: null as string | null };
  protected commands: string[] = [];
  protected scopes: string[] = [];

  protected readonly otherAgents = computed(() =>
    this.store.data().agents.filter((other) => other.id !== this.agent().id),
  );
  protected readonly handoffName = computed(() => {
    const target = this.store.data().agents.find((other) => other.id === this.agent().handoffTo);
    return target ? target.name : 'Nächster Agent im Workflow';
  });

  /** Noch nicht festgelegt (null): so, wie der Agent heute läuft – vertraute Rollen mit allen Projektbefehlen. */
  private effectiveCommands(agent: Agent): string[] {
    if (agent.allowedCommands) return [...agent.allowedCommands];
    const available = this.groups()
      .filter((group) => group.available)
      .flatMap((group) => group.rules);
    return ['assistant', 'developer', 'tester', 'reviewer'].includes(agent.role)
      ? available
      : ['files:create', 'files:edit'];
  }

  private readonly instructionsField = viewChild<ElementRef<HTMLTextAreaElement>>('instructionsField');

  protected startEdit(focusInstructions = false): void {
    const agent = this.agent();
    this.form = {
      name: agent.name,
      instructions: agent.instructions,
      command: agent.command?.join(' ') ?? '',
      handoffTo: agent.handoffTo ?? null,
    };
    this.commands = this.effectiveCommands(agent);
    this.scopes = [...(agent.fileScope ?? [])];
    this.editing.set(true);
    if (focusInstructions) globalThis.setTimeout(() => this.instructionsField()?.nativeElement.focus());
  }

  protected applyPreset(id: string): void {
    const preset = MODEL_PRESETS.find((item) => item.id === id);
    if (preset) this.form.command = preset.command;
  }

  protected cancel(): void {
    this.editing.set(false);
  }

  protected async save(): Promise<void> {
    let command: string[] | null;
    try {
      command = parseCommand(this.form.command);
    } catch (error) {
      this.store.notice.set(errorMessage(error, 'Der Agent-Befehl ist ungültig.'));
      return;
    }
    await this.store.perform(
      () =>
        this.api.patch(`/api/agents/${encodeURIComponent(this.agent().id)}`, {
          name: this.form.name,
          instructions: this.form.instructions,
          // Den Befehl ändert nur die Administration (sonst 403 vom Server).
          command: this.auth.can('admin') ? command : undefined,
          handoffTo: this.form.handoffTo,
          allowedCommands: this.commands,
          fileScope: this.scopes,
        }),
      'Agent gespeichert.',
    );
    this.editing.set(false);
    this.saved.emit();
  }
}
