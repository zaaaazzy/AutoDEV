import { Component, computed, inject, input } from '@angular/core';
import { ApiService } from '../core/api.service.js';
import type { Attachment } from '../core/models.js';
import { ProjectStore } from '../core/project-store.js';

/** Bilder einer Idee oder eines Bugs. */
@Component({
  selector: 'app-gallery',
  standalone: true,
  templateUrl: './gallery.component.html',
  host: { style: 'display: contents' },
})
export class GalleryComponent {
  private readonly api = inject(ApiService);
  private readonly store = inject(ProjectStore);

  readonly ideationId = input<string | null | undefined>(null);
  readonly bugId = input<string | null | undefined>(null);
  readonly removable = input(false);
  protected readonly busy = this.store.busy;
  protected readonly images = computed<Attachment[]>(() => {
    const ideationId = this.ideationId();
    const bugId = this.bugId();
    return this.store
      .data()
      .attachments.filter(
        (image) => (ideationId && image.ideationId === ideationId) || (bugId && image.bugId === bugId),
      );
  });

  protected imageUrl(image: Attachment): string {
    return this.api.url(`/api/attachments/${encodeURIComponent(image.id)}`);
  }

  protected async remove(image: Attachment): Promise<void> {
    if (!confirm(`Bild „${image.filename}“ entfernen?`)) return;
    await this.store.perform(
      () => this.api.delete(`/api/attachments/${encodeURIComponent(image.id)}`),
      'Bild entfernt.',
    );
  }
}
