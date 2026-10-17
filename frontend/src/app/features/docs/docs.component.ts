import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../core/api.service.js';
import type { DocumentEntry } from '../../core/models.js';
import { ProjectStore } from '../../core/project-store.js';
import type { FormValues } from '../../shared/forms.js';
import { MarkdownPipe } from '../../shared/markdown.pipe.js';

import { formatIsoDate } from '../../shared/format.js';
import {
  type DataColumn,
  DataCellDirective,
  DataDetailDirective,
  DataTableComponent,
} from '../../shared/data-table/data-table.component.js';

const KIND_RANK: DocumentEntry['kind'][] = ['manual', 'sprint', 'order', 'repo'];

@Component({
  selector: 'app-docs',
  standalone: true,
  imports: [FormsModule, MarkdownPipe, DataTableComponent, DataCellDirective, DataDetailDirective],
  templateUrl: './docs.component.html',
  host: { style: 'display: contents' },
})
export class DocsComponent {
  private readonly api = inject(ApiService);
  protected readonly store = inject(ProjectStore);
  protected readonly data = this.store.data;
  protected readonly openDoc = signal<string | null>(null);
  protected readonly docId = (doc: DocumentEntry): string => doc.id;
  protected readonly docColumns: DataColumn<DocumentEntry>[] = [
    { id: 'title', header: 'Titel', value: (doc) => doc.title, filter: 'text', className: 'title-cell' },
    {
      id: 'kind',
      header: 'Art',
      value: (doc) => this.documentKindLabel(doc.kind),
      sortValue: (doc) => KIND_RANK.indexOf(doc.kind),
    },
    {
      id: 'updatedAt',
      header: 'Aktualisiert',
      value: (doc) => formatIsoDate(doc.updatedAt),
      sortValue: (doc) => doc.updatedAt,
      filter: false,
    },
  ];

  protected toggleDoc(id: string): void {
    this.openDoc.update((current) => (current === id ? null : id));
  }
  protected docForm = { title: '', content: '' };
  protected readonly documentGroups: { kind: DocumentEntry['kind']; label: string }[] = [
    { kind: 'manual', label: 'Handbücher' },
    { kind: 'sprint', label: 'Sprintberichte' },
    { kind: 'order', label: 'Auftrags-Dokumentation' },
    { kind: 'repo', label: 'Repository' },
  ];

  protected docsOfKind(kind: DocumentEntry['kind']): DocumentEntry[] {
    return this.data().docs.filter((doc) => doc.kind === kind);
  }

  protected documentKindLabel(kind: DocumentEntry['kind']): string {
    return this.documentGroups.find((item) => item.kind === kind)?.label ?? kind;
  }

  protected async createDocument(): Promise<void> {
    await this.store.perform(async () => {
      await this.api.post(`${this.api.projectPath(this.store.activeProject())}/docs`, this.docForm);
      this.docForm = { title: '', content: '' };
      this.store.showCreate.set(false);
    }, 'Dokument gespeichert.');
  }

  protected async saveDocument(doc: DocumentEntry, values: FormValues): Promise<void> {
    await this.store.perform(
      () =>
        this.api.patch(`/api/docs/${encodeURIComponent(doc.id)}`, {
          title: String(values['title'] ?? ''),
          content: String(values['content'] ?? ''),
        }),
      'Dokument gespeichert.',
    );
  }

  protected async deleteDocument(id: string): Promise<void> {
    if (!globalThis.confirm('Dokument löschen?')) return;
    await this.store.perform(async () => {
      await this.api.delete(`/api/docs/${encodeURIComponent(id)}`);
      if (this.openDoc() === id) this.openDoc.set(null);
    }, 'Dokument gelöscht.');
  }
}
