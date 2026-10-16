import { Component, computed, inject, input } from '@angular/core';
import { ApiService } from '../core/api.service.js';
import type { Attachment } from '../core/models.js';
import { ProjectStore } from '../core/project-store.js';

/** Bilder einer Idee. */
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
  protected readonly images = computed<Attachment[]>(() => {
    const id = this.ideationId();
    return id ? this.store.data().attachments.filter((image) => image.ideationId === id) : [];
  });

  protected imageUrl(image: Attachment): string {
    return this.api.url(`/api/attachments/${encodeURIComponent(image.id)}`);
  }
}
