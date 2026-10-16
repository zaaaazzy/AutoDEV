import { Component, effect, inject, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../core/api.service.js';
import type { DocumentEntry } from '../../core/models.js';
import { ProjectStore } from '../../core/project-store.js';
import type { FormValues } from '../../shared/forms.js';
import { MarkdownPipe } from '../../shared/markdown.pipe.js';
import { DateTimePipe } from '../../shared/pipes.js';

@Component({
  selector: 'app-docs',
  standalone: true,
  imports: [FormsModule, MarkdownPipe, DateTimePipe],
  templateUrl: './docs.component.html',
  host: { style: 'display: contents' },
})
export class DocsComponent {
  private readonly api = inject(ApiService);
  protected readonly store = inject(ProjectStore);
  protected readonly data = this.store.data;
  protected readonly selectedDoc = signal<DocumentEntry | null>(null);
  protected docForm = { title: '', content: '' };
  protected readonly documentGroups: { kind: DocumentEntry['kind']; label: string }[] = [
    { kind: 'manual', label: 'Handbücher' },
    { kind: 'sprint', label: 'Sprintberichte' },
    { kind: 'order', label: 'Auftrags-Dokumentation' },
    { kind: 'repo', label: 'Repository' },
  ];

  constructor() {
    effect(() => {
      const docs = this.data().docs;
      untracked(() => {
        const current = this.selectedDoc();
        if (!current || !docs.some((doc) => doc.id === current.id)) this.selectedDoc.set(docs[0] ?? null);
      });
    });
  }

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
    await this.store.perform(() => this.api.patch(`/api/docs/${encodeURIComponent(doc.id)}`, {
      title: String(values['title'] ?? ''),
      content: String(values['content'] ?? ''),
    }), 'Dokument gespeichert.');
  }

  protected async deleteDocument(id: string): Promise<void> {
    if (!globalThis.confirm('Dokument löschen?')) return;
    await this.store.perform(async () => {
      await this.api.delete(`/api/docs/${encodeURIComponent(id)}`);
      if (this.selectedDoc()?.id === id) this.selectedDoc.set(null);
    }, 'Dokument gelöscht.');
  }
}
