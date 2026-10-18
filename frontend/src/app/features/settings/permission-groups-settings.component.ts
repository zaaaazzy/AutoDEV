import { Component, effect, inject, signal } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../core/api.service.js';
import { errorMessage } from '../../core/errors.js';
import { ProjectStore } from '../../core/project-store.js';
import type { PermissionGroupInfo } from '../agents/permission-picker.component.js';

/**
 * Rechte-Gruppen des Projekts (nur Administration): eingebaute ansehen, eigene anlegen, ändern und löschen.
 * Eigene Gruppen gelten nur in diesem Projekt (Mandantentrennung); gefährliche Befehle lehnt der Server ab.
 */
@Component({
  selector: 'app-permission-groups-settings',
  standalone: true,
  imports: [FormsModule, NgTemplateOutlet],
  templateUrl: './permission-groups-settings.component.html',
})
export class PermissionGroupsSettingsComponent {
  private readonly api = inject(ApiService);
  protected readonly store = inject(ProjectStore);
  protected readonly groups = signal<PermissionGroupInfo[]>([]);
  protected readonly editing = signal<string | null>(null);
  protected readonly error = signal('');
  protected form = { label: '', description: '', rules: '' };

  constructor() {
    effect(() => {
      const slug = this.store.activeProject();
      if (slug) void this.load(slug);
    });
  }

  private base(): string {
    return `${this.api.projectPath(this.store.activeProject())}/permission-groups`;
  }

  private async load(slug: string): Promise<void> {
    const result = await this.api
      .get<{ groups: PermissionGroupInfo[] }>(`${this.api.projectPath(slug)}/permission-groups`)
      .catch(() => null);
    if (result && slug === this.store.activeProject()) this.groups.set(result.groups);
  }

  protected startNew(): void {
    this.form = { label: '', description: '', rules: '' };
    this.error.set('');
    this.editing.set('new');
  }

  protected startEdit(group: PermissionGroupInfo): void {
    this.form = { label: group.label, description: group.description, rules: group.rules.join('\n') };
    this.error.set('');
    this.editing.set(group.id);
  }

  protected async save(): Promise<void> {
    const id = this.editing();
    if (!id) return;
    this.error.set('');
    try {
      if (id === 'new') await this.api.post(this.base(), this.form);
      else await this.api.patch(`${this.base()}/${encodeURIComponent(id)}`, this.form);
      this.editing.set(null);
      await this.load(this.store.activeProject());
      this.store.notice.set('Kategorie gespeichert.');
    } catch (error) {
      this.error.set(errorMessage(error, 'Kategorie konnte nicht gespeichert werden.'));
    }
  }

  protected async remove(group: PermissionGroupInfo): Promise<void> {
    if (!globalThis.confirm(`Kategorie „${group.label}“ löschen? Ihre Befehle werden auch allen Agents entzogen.`))
      return;
    await this.store.perform(
      () => this.api.delete(`${this.base()}/${encodeURIComponent(group.id)}`),
      'Kategorie gelöscht.',
    );
    await this.load(this.store.activeProject());
  }
}
