import { Component, inject, output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../core/api.service.js';
import type { Project } from '../../core/models.js';
import { ProjectStore } from '../../core/project-store.js';

/** Formular zum Verbinden eines neuen Projekts. */
@Component({
  selector: 'app-project-form',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './project-form.component.html',
  host: { style: 'display: contents' },
})
export class ProjectFormComponent {
  private readonly api = inject(ApiService);
  private readonly store = inject(ProjectStore);
  protected readonly busy = this.store.busy;
  protected projectForm = { name: '', slug: '', repository: '', gitRemote: '' };

  readonly saved = output<void>();

  protected async createProject(): Promise<void> {
    await this.store.perform(async () => {
      const result = await this.api.post<{ project: Project }>('/api/projects', {
        slug: this.projectForm.slug.trim(),
        name: this.projectForm.name.trim(),
        repository: this.projectForm.repository.trim(),
      });
      if (this.projectForm.gitRemote.trim()) {
        await this.api.patch(`/api/projects/${encodeURIComponent(result.project.slug)}`, {
          gitRemote: this.projectForm.gitRemote.trim(),
        });
      }
      this.projectForm = { name: '', slug: '', repository: '', gitRemote: '' };
      this.saved.emit();
      await this.store.loadProjects(result.project.slug);
    }, 'Projekt wurde gespeichert.', false);
  }
}
