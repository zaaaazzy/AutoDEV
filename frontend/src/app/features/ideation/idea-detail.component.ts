import { DatePipe } from '@angular/common';
import { Component, inject, input, model, output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../core/api.service.js';
import type { Idea } from '../../core/models.js';
import { ProjectStore } from '../../core/project-store.js';
import type { FormValues } from '../../shared/forms.js';
import { GalleryComponent } from '../../shared/gallery.component.js';
import { PriorityLabelPipe, StatusLabelPipe } from '../../shared/pipes.js';
import { IDEA_SELECTABLE_STATUSES } from './idea-options.js';

/** Dialog mit Details, Bearbeitung und Kommentaren einer Idee. */
@Component({
  selector: 'app-idea-detail',
  standalone: true,
  imports: [DatePipe, FormsModule, GalleryComponent, PriorityLabelPipe, StatusLabelPipe],
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

  protected statusOptions(idea: Idea): string[] {
    return IDEA_SELECTABLE_STATUSES.includes(idea.status) ? IDEA_SELECTABLE_STATUSES : [idea.status];
  }

  protected linkedOrder(ideationId: string) {
    return this.data().development.find((item) => item.ideationId === ideationId);
  }

  protected commentsOf(ideationId: string) {
    return this.data().comments.filter((comment) => comment.ideationId === ideationId);
  }

  protected async saveIdea(idea: Idea, values: FormValues): Promise<void> {
    await this.store.perform(
      () =>
        this.api.patch(`/api/ideation/${encodeURIComponent(idea.id)}`, {
          title: String(values['title'] ?? ''),
          description: String(values['description'] ?? ''),
          ...(IDEA_SELECTABLE_STATUSES.includes(idea.status) ? { status: values['status'] } : {}),
          priority: values['priority'],
        }),
      'Idee gespeichert.',
    );
    this.editing.set(false);
  }

  protected async promoteIdea(idea: Idea): Promise<void> {
    await this.store.perform(
      () => this.api.post(`/api/ideation/${encodeURIComponent(idea.id)}/define`),
      'Der Agent formuliert den Auftrag aus.',
    );
  }

  protected async addComment(ideationId: string, input: HTMLInputElement): Promise<void> {
    const body = input.value.trim();
    if (!body) return;
    await this.store.perform(
      () => this.api.post(`/api/ideation/${encodeURIComponent(ideationId)}/comments`, { body }),
      'Kommentar gespeichert.',
    );
    input.value = '';
  }
}
