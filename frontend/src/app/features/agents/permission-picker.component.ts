import { Component, computed, input, model } from '@angular/core';

export interface PermissionCommand {
  rule: string;
  label: string;
  /** Erklärung beim Überfahren. */
  help: string;
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

const FILE_RIGHTS = ['files:create', 'files:edit'];

/**
 * Rechte eines Agents, kompakt: Kategorien zum Aufklappen, darin jeder Befehl einzeln zum Abhaken (Erklärung beim
 * Überfahren). Bei den Dateirechten lässt sich das Schreiben auf Ordner einschränken. Gezeigt werden nur Kategorien,
 * die im Projekt verfügbar sind.
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
                <label
                  class="permission-command"
                  [class.on]="selected().includes(command.rule)"
                  [attr.data-help]="command.help"
                  [attr.aria-description]="command.help"
                >
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
            @if (group.id === 'files' && writes()) {
              <label class="permission-scope">
                <span>Nur in diesen Ordnern <small class="muted">(leer = ganzes Projekt)</small></span>
                <input
                  type="text"
                  [value]="scopes().join(', ')"
                  [disabled]="disabled()"
                  placeholder="z. B. docs, src/app"
                  aria-label="Erlaubte Ordner"
                  (change)="setScopes($any($event.target).value)"
                />
              </label>
            }
          </details>
        }
      }
      <small class="muted permission-hint"
        >Lesen und Durchsuchen ist immer erlaubt. Jeder Schreib- und Shell-Zugriff wird vor der Ausführung geprüft;
        immer gesperrt: rm, sudo, kill, git push, .env/.git/.claude und Dev Log selbst.</small
      >
    </div>
  `,
})
export class PermissionPickerComponent {
  readonly groups = input.required<PermissionGroupInfo[]>();
  readonly selected = model.required<string[]>();
  /** Erlaubte Ordner für die Dateirechte (relativ zum Projekt). */
  readonly scopes = model<string[]>([]);
  readonly disabled = input(false);

  protected readonly writes = computed(() => FILE_RIGHTS.some((rule) => this.selected().includes(rule)));

  protected count(group: PermissionGroupInfo): number {
    return group.commands.filter((command) => this.selected().includes(command.rule)).length;
  }

  protected toggle(rule: string): void {
    const current = this.selected();
    this.selected.set(current.includes(rule) ? current.filter((entry) => entry !== rule) : [...current, rule]);
  }

  protected setScopes(value: string): void {
    this.scopes.set([
      ...new Set(
        value
          .split(/[,\n]/)
          .map((entry) => entry.trim().replace(/^\.\//, '').replace(/\/+$/, ''))
          .filter(Boolean),
      ),
    ]);
  }
}
