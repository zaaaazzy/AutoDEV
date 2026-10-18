import { NgClass } from '@angular/common';
import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../core/api.service.js';
import type { Bug, BugStatus, Sprint } from '../../core/models.js';
import { ProjectStore } from '../../core/project-store.js';
import type { FormValues } from '../../shared/forms.js';
import {
  type DataColumn,
  DataCellDirective,
  DataDetailDirective,
  DataTableComponent,
} from '../../shared/data-table/data-table.component.js';
import { formatIsoDate } from '../../shared/format.js';
import { CATEGORIES, severityLabel, statusLabel } from '../../shared/labels.js';
import { categoryColumn } from '../../shared/data-table/columns.js';
import { GalleryComponent } from '../../shared/gallery.component.js';
import { MarkdownPipe } from '../../shared/markdown.pipe.js';
import {
  CategoryLabelPipe,
  SeverityLabelPipe,
  ShortTextPipe,
  StatusClassPipe,
  StatusLabelPipe,
} from '../../shared/pipes.js';

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const SEVERITY_RANK = ['low', 'medium', 'high', 'critical'];
const BUG_STATUS_RANK = ['open', 'in_progress', 'fixed', 'wontfix', 'rejected'];

const BUG_SOURCE_LABEL: Record<string, string> = { agent: 'Agent', manual: 'Manuell', test: 'Testlauf' };
@Component({
  selector: 'app-bugs',
  standalone: true,
  imports: [
    NgClass,
    FormsModule,
    DataTableComponent,
    DataCellDirective,
    DataDetailDirective,
    GalleryComponent,
    MarkdownPipe,
    SeverityLabelPipe,
    ShortTextPipe,
    StatusClassPipe,
    StatusLabelPipe,
    CategoryLabelPipe,
  ],
  templateUrl: './bugs.component.html',
  host: { style: 'display: contents' },
})
export class BugsComponent {
  private readonly api = inject(ApiService);
  protected readonly store = inject(ProjectStore);
  protected readonly data = this.store.data;
  protected readonly busy = this.store.busy;
  protected readonly bugStatuses: BugStatus[] = ['open', 'in_progress', 'fixed', 'wontfix', 'rejected'];
  protected readonly openBug = signal<string | null>(null);
  protected readonly bugId = (bug: Bug): string => bug.id;
  protected readonly bugColumns: DataColumn<Bug>[] = [
    { id: 'title', header: 'Titel', value: (bug) => bug.title, filter: 'text', className: 'title-cell' },
    {
      id: 'status',
      header: 'Status',
      value: (bug) => statusLabel(bug.status),
      sortValue: (bug) => BUG_STATUS_RANK.indexOf(bug.status),
    },
    {
      id: 'severity',
      header: 'Schweregrad',
      value: (bug) => severityLabel(bug.severity),
      sortValue: (bug) => SEVERITY_RANK.indexOf(bug.severity),
    },
    categoryColumn<Bug>((bug) => bug.category),
    { id: 'source', header: 'Quelle', value: (bug) => BUG_SOURCE_LABEL[bug.source] ?? 'Manuell' },
    {
      id: 'sprint',
      header: 'Sprint',
      value: (bug) => this.data().sprints.find((sprint) => sprint.id === bug.sprintId)?.name ?? 'Kein Sprint',
    },
    {
      id: 'createdAt',
      header: 'Erstellt',
      value: (bug) => formatIsoDate(bug.createdAt),
      sortValue: (bug) => bug.createdAt,
    },
  ];
  protected bugForm = { title: '', description: '', severity: 'medium', sprintId: '', category: '' };
  protected readonly categories = CATEGORIES;
  protected pendingImages: File[] = [];

  protected toggleBug(id: string): void {
    this.openBug.update((current) => (current === id ? null : id));
  }

  protected availableSprints(): Sprint[] {
    return this.data().sprints.filter((sprint) => sprint.status !== 'completed');
  }

  protected async createBug(): Promise<void> {
    const body = { ...this.bugForm, sprintId: this.bugForm.sprintId || null };
    const files = this.pendingImages;
    await this.store.perform(async () => {
      const created = await this.api.post<{ bug: Bug }>(
        `${this.api.projectPath(this.store.activeProject())}/bugs`,
        body,
      );
      this.pendingImages = [];
      await this.uploadImages(created.bug.id, files);
      this.bugForm = { title: '', description: '', severity: 'medium', sprintId: '', category: '' };
      this.store.showCreate.set(false);
    }, 'Bug wurde gemeldet.');
  }

  protected pendingImageNames(): string {
    return this.pendingImages.map((file) => file.name).join(', ');
  }

  protected selectPendingImages(input: HTMLInputElement): void {
    this.pendingImages = [...this.pendingImages, ...Array.from(input.files ?? [])];
    input.value = '';
  }

  protected async addImages(bugId: string, input: HTMLInputElement): Promise<void> {
    const files = Array.from(input.files ?? []);
    input.value = '';
    if (!files.length) return;
    await this.store.perform(
      () => this.uploadImages(bugId, files),
      files.length === 1 ? 'Bild angehängt.' : `${files.length} Bilder angehängt.`,
    );
  }

  private async uploadImages(bugId: string, files: File[]): Promise<void> {
    for (const file of files) {
      if (file.size > MAX_IMAGE_BYTES) throw new Error(`${file.name} ist größer als 5 MB.`);
      await this.api.upload(`/api/bugs/${encodeURIComponent(bugId)}/attachments`, file);
    }
  }

  protected async saveBug(bug: Bug, values: FormValues): Promise<void> {
    await this.store.perform(
      () =>
        this.api.patch(`/api/bugs/${encodeURIComponent(bug.id)}`, {
          title: String(values['title'] ?? ''),
          description: String(values['description'] ?? ''),
          severity: values['severity'],
          sprintId: values['sprintId'] || null,
          fixNotes: String(values['fixNotes'] ?? ''),
          category: values['category'] || null,
        }),
      'Bug wurde gespeichert.',
    );
  }

  protected async updateBug(id: string, values: Partial<Bug>): Promise<void> {
    await this.store.perform(() => this.api.patch(`/api/bugs/${encodeURIComponent(id)}`, values), 'Bug aktualisiert.');
  }

  protected async deleteBug(id: string): Promise<void> {
    if (!globalThis.confirm('Bug löschen?')) return;
    await this.store.perform(() => this.api.delete(`/api/bugs/${encodeURIComponent(id)}`), 'Bug gelöscht.');
  }
}
