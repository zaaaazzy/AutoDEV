import { DatePipe, DecimalPipe } from '@angular/common';
import { Component, inject, input, model, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../core/api.service.js';
import type { Idea } from '../../core/models.js';
import { ProjectStore } from '../../core/project-store.js';
import type { FormValues } from '../../shared/forms.js';
import { GalleryComponent } from '../../shared/gallery.component.js';
import { MarkdownPipe } from '../../shared/markdown.pipe.js';
import { CategoryLabelPipe, PriorityLabelPipe, StatusClassPipe, StatusLabelPipe } from '../../shared/pipes.js';
import { CATEGORIES } from '../../shared/labels.js';
import { CommentThreadComponent } from './comment-thread.component.js';
import { IDEA_SELECTABLE_STATUSES, ideaDisplayStatus, MAX_IMAGE_BYTES } from './idea-options.js';

/** Dialog mit Details, Bearbeitung und Kommentaren einer Idee. */
@Component({
  selector: 'app-idea-detail',
  standalone: true,
  imports: [
    CommentThreadComponent,
    DatePipe,
    DecimalPipe,
    FormsModule,
    GalleryComponent,
    MarkdownPipe,
    CategoryLabelPipe,
    PriorityLabelPipe,
    StatusClassPipe,
    StatusLabelPipe,
  ],
  templateUrl: './idea-detail.component.html',
  host: { style: 'display: contents' },
})
export class IdeaDetailComponent {
  private readonly api = inject(ApiService);
  private readonly store = inject(ProjectStore);
  protected readonly data = this.store.data;
  protected readonly busy = this.store.busy;

  readonly selected = input.required<Idea>();
  readonly editing = model(false);
  readonly closed = output<void>();
  protected readonly categories = CATEGORIES;

  protected statusOptions(idea: Idea): string[] {
    return IDEA_SELECTABLE_STATUSES.includes(idea.status) ? IDEA_SELECTABLE_STATUSES : [idea.status];
  }

  protected displayStatus(idea: Idea): string {
    return ideaDisplayStatus(idea, this.linkedOrder(idea.id));
  }

  protected canPromote(idea: Idea): boolean {
    return !this.linkedOrder(idea.id) && IDEA_SELECTABLE_STATUSES.includes(idea.status);
  }

  protected linkedOrder(ideationId: string) {
    return this.data().development.find((item) => item.ideationId === ideationId);
  }

  protected commentCount(ideationId: string): number {
    return this.data().comments.filter((comment) => comment.ideationId === ideationId).length;
  }

  protected imageCount(ideationId: string): number {
    return this.data().attachments.filter((image) => image.ideationId === ideationId).length;
  }

  protected async saveIdea(idea: Idea, values: FormValues): Promise<void> {
    await this.store.perform(
      () =>
        this.api.patch(`/api/ideation/${encodeURIComponent(idea.id)}`, {
          title: String(values['title'] ?? ''),
          description: String(values['description'] ?? ''),
          ...(IDEA_SELECTABLE_STATUSES.includes(idea.status) ? { status: values['status'] } : {}),
          priority: values['priority'],
          category: values['category'] || null,
        }),
      'Idee gespeichert.',
    );
    this.editing.set(false);
  }

  protected async addImages(idea: Idea, input: HTMLInputElement): Promise<void> {
    const files = Array.from(input.files ?? []);
    input.value = '';
    if (!files.length) return;
    await this.store.perform(
      async () => {
        for (const file of files) {
          if (file.size > MAX_IMAGE_BYTES) throw new Error(`${file.name} ist größer als 5 MB.`);
          await this.api.upload(`/api/ideation/${encodeURIComponent(idea.id)}/attachments`, file);
        }
      },
      files.length === 1 ? 'Bild angehängt.' : `${files.length} Bilder angehängt.`,
    );
  }

  protected readonly rejecting = signal(false);
  protected rejectReason = '';

  /** Ablehnen mit Grund: Status „Abgelehnt“, der Grund wird gespeichert und fliesst in den nächsten Visionär-Lauf. */
  protected async rejectIdea(idea: Idea): Promise<void> {
    const reason = this.rejectReason.trim();
    if (!reason) return;
    await this.store.perform(
      () => this.api.post(`/api/ideation/${encodeURIComponent(idea.id)}/reject`, { reason }),
      'Idee abgelehnt.',
    );
    this.rejecting.set(false);
    this.rejectReason = '';
  }

  protected async promoteIdea(idea: Idea): Promise<void> {
    await this.store.perform(
      () => this.api.post(`/api/ideation/${encodeURIComponent(idea.id)}/define`),
      'Der Agent formuliert den Auftrag aus.',
    );
  }
}
