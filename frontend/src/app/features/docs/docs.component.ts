import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../core/api.service.js';
import { AuthService } from '../../core/auth.service.js';
import type { DocRevision, DocumentEntry } from '../../core/models.js';
import { ProjectStore } from '../../core/project-store.js';
import type { FormValues } from '../../shared/forms.js';
import { MarkdownPipe } from '../../shared/markdown.pipe.js';
import { DateTimePipe } from '../../shared/pipes.js';
import { searchDocs } from './doc-search.js';
import { compactDiff, lineDiff } from './line-diff.js';

const COLLAPSED_KEY = 'devlog.docs.collapsed';

function readCollapsed(): boolean {
  try {
    return globalThis.localStorage?.getItem(COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

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
  protected readonly auth = inject(AuthService);
  protected readonly data = this.store.data;
  protected readonly selectedDoc = signal<DocumentEntry | null>(null);
  protected docForm = { title: '', content: '' };
  /** Aufgeklappte Gruppen links; Vorgabe: nur die Handbücher. */
  protected readonly openGroups = signal(new Set<DocumentEntry['kind']>(['manual']));
  /** Dokument, das gerade bearbeitet wird (sonst Lesemodus). */
  protected readonly editing = signal<string | null>(null);
  protected readonly query = signal('');
  protected readonly hits = computed(() => searchDocs(this.data().docs, this.query()));
  /** Inhaltsverzeichnis zugeklappt (Desktop: Buch-Symbol, Handy: nach oben eingeklappt). */
  protected readonly collapsed = signal(readCollapsed());
  /** Offene und erledigte Änderungen je Dokument. */
  protected readonly revisionsByDoc = computed(() => {
    const map = new Map<string, DocRevision[]>();
    for (const revision of this.data().docRevisions) {
      map.set(revision.docId, [...(map.get(revision.docId) ?? []), revision]);
    }
    return map;
  });
  protected readonly pendingCount = computed(
    () => this.data().docRevisions.filter((revision) => revision.status === 'pending').length,
  );
  protected readonly reviewNote = signal('');
  protected readonly documentGroups: { kind: DocumentEntry['kind']; label: string }[] = [
    { kind: 'manual', label: 'Handbücher' },
    { kind: 'sprint', label: 'Sprintberichte' },
    { kind: 'order', label: 'Auftrags-Dokumentation' },
    { kind: 'repo', label: 'Repository' },
    // Anfragen an Assistent und Agents (auch Kurzbefehle) samt Ergebnis, neueste zuerst.
    { kind: 'request', label: 'Anfragen' },
  ];

  constructor() {
    // Link auf ein Dokument (#docs/<id>, z. B. „ToDo im Sprintbericht“): dieses Dokument öffnen.
    effect(() => {
      const id = this.store.focusId();
      const doc = id ? this.data().docs.find((entry) => entry.id === id) : undefined;
      if (doc) untracked(() => this.select(doc));
    });
    effect(() => {
      const docs = this.data().docs;
      untracked(() => {
        const current = this.selectedDoc();
        if (!current || !docs.some((doc) => doc.id === current.id)) {
          this.selectedDoc.set(docs.find((doc) => doc.kind === 'manual') ?? docs[0] ?? null);
        } else {
          // Nach einer Freigabe den aktualisierten Stand anzeigen.
          this.selectedDoc.set(docs.find((doc) => doc.id === current.id) ?? current);
        }
      });
    });
  }

  protected toggleGroup(kind: DocumentEntry['kind'], open: boolean): void {
    const next = new Set(this.openGroups());
    if (open) next.add(kind);
    else next.delete(kind);
    this.openGroups.set(next);
  }

  protected select(doc: DocumentEntry): void {
    this.selectedDoc.set(doc);
    this.editing.set(null);
    // Gruppe des gewählten Dokuments aufklappen, damit die Auswahl sichtbar bleibt.
    this.toggleGroup(doc.kind, true);
    if (globalThis.matchMedia?.('(max-width: 720px)').matches) this.setCollapsed(true);
  }

  protected search(value: string): void {
    this.query.set(value);
    if (value.trim() && this.collapsed()) this.setCollapsed(false);
  }

  protected revisionsOf(doc: DocumentEntry): DocRevision[] {
    return this.revisionsByDoc().get(doc.id) ?? [];
  }

  protected pendingOf(doc: DocumentEntry): DocRevision[] {
    return this.revisionsOf(doc).filter((revision) => revision.status === 'pending');
  }

  protected canEdit(doc: DocumentEntry): boolean {
    return doc.kind !== 'repo' && doc.kind !== 'request' && this.auth.can('docs');
  }

  protected diff(revision: DocRevision) {
    return compactDiff(lineDiff(revision.baseContent, revision.content));
  }

  protected setCollapsed(collapsed: boolean): void {
    this.collapsed.set(collapsed);
    try {
      globalThis.localStorage?.setItem(COLLAPSED_KEY, collapsed ? '1' : '0');
    } catch {
      // nur Komfort – ohne Speicher bleibt die Wahl bis zum Neuladen
    }
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

  protected async submitRevision(doc: DocumentEntry, values: FormValues): Promise<void> {
    await this.store.perform(
      () =>
        this.api.post(`/api/docs/${encodeURIComponent(doc.id)}/revisions`, {
          title: String(values['title'] ?? ''),
          content: String(values['content'] ?? ''),
          note: String(values['note'] ?? ''),
        }),
      'Änderung eingereicht – sie gilt, sobald die Redaktion sie freigibt.',
    );
    this.editing.set(null);
  }

  protected async review(revision: DocRevision, decision: 'approve' | 'reject'): Promise<void> {
    await this.store.perform(
      () =>
        this.api.post(`/api/doc-revisions/${encodeURIComponent(revision.id)}/${decision}`, {
          note: this.reviewNote(),
        }),
      decision === 'approve' ? 'Änderung freigegeben – das Dokument ist aktualisiert.' : 'Änderung abgelehnt.',
    );
    this.reviewNote.set('');
  }

  protected async deleteDocument(id: string): Promise<void> {
    if (!globalThis.confirm('Dokument löschen?')) return;
    await this.store.perform(async () => {
      await this.api.delete(`/api/docs/${encodeURIComponent(id)}`);
      if (this.selectedDoc()?.id === id) this.selectedDoc.set(null);
    }, 'Dokument gelöscht.');
  }
}
