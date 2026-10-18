import { Component, input, model } from '@angular/core';

export interface PermissionCommand {
  rule: string;
  label: string;
}

export interface PermissionGroupInfo {
  id: string;
  label: string;
  description: string;
  rules: string[];
  commands: PermissionCommand[];
  builtIn: boolean;
  available: boolean;
}

/**
 * Rechte eines Agents, kompakt: Kategorien zum Aufklappen, darin jeder Befehl einzeln zum Abhaken.
 * Gezeigt werden nur Kategorien, die im Projekt verfügbar sind.
 */
@Component({
  selector: 'app-permission-picker',
  standalone: true,
  template: `
    <div class="permission-picker">
      <span class="permission-title">Rechte <small class="muted">– jeden Befehl einzeln freigeben</small></span>
      @for (group of groups(); track group.id) {
        @if (group.available && group.commands.length) {
          <details class="permission-category" [open]="count(group) > 0">
            <summary [title]="group.description">
              {{ group.label }}
              <span class="permission-count" [class.on]="count(group) > 0"
                >{{ count(group) }}/{{ group.commands.length }}</span
              >
              @if (!group.builtIn) {
                <small class="muted">eigene</small>
              }
            </summary>
            <div class="permission-commands">
              @for (command of group.commands; track command.rule) {
                <label class="permission-command" [class.on]="selected().includes(command.rule)" [title]="command.rule">
                  <input
                    type="checkbox"
                    [checked]="selected().includes(command.rule)"
                    [disabled]="disabled()"
                    (change)="toggle(command.rule)"
                  />
                  <code>{{ command.label }}</code>
                </label>
              }
            </div>
          </details>
        }
      }
      <small class="muted permission-hint"
        >Ohne „Dateien erstellen und ändern“ darf der Agent nur lesen. Immer gesperrt: rm, sudo, kill, git push und Dev
        Log selbst.</small
      >
    </div>
  `,
})
export class PermissionPickerComponent {
  readonly groups = input.required<PermissionGroupInfo[]>();
  readonly selected = model.required<string[]>();
  readonly disabled = input(false);

  protected count(group: PermissionGroupInfo): number {
    return group.commands.filter((command) => this.selected().includes(command.rule)).length;
  }

  protected toggle(rule: string): void {
    const current = this.selected();
    this.selected.set(current.includes(rule) ? current.filter((entry) => entry !== rule) : [...current, rule]);
  }
}
