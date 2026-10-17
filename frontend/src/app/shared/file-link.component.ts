import { Component, computed, ElementRef, inject, input, signal } from '@angular/core';
import { ApiService } from '../core/api.service.js';
import { ProjectStore } from '../core/project-store.js';
import { repositoryWebUrl } from './changed-files.component.js';

interface FilePreview {
  path: string;
  content: string;
  truncated: boolean;
  binary: boolean;
}

const HOVER_DELAY_MS = 250;
const previews = new Map<string, Promise<FilePreview | null>>();

/** Dateipfad als Link ins Repository; beim Hovern erscheint der Anfang der Datei als Vorschau. */
@Component({
  selector: 'app-file-link',
  standalone: true,
  templateUrl: './file-link.component.html',
  host: {
    class: 'file-link',
    '(mouseenter)': 'enter()',
    '(mouseleave)': 'leave()',
    '(focusin)': 'enter()',
    '(focusout)': 'leave()',
  },
})
export class FileLinkComponent {
  private readonly api = inject(ApiService);
  private readonly store = inject(ProjectStore);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  readonly path = input.required<string>();
  /** Commit oder Branch für den Link; HEAD zeigt den Stand des Standard-Branches. */
  readonly gitRef = input<string | null | undefined>(null);

  protected readonly open = signal(false);
  /** Feste Position am Bildschirm, damit scrollende Tabellen die Vorschau nicht abschneiden. */
  protected readonly position = signal({ top: 0, left: 0 });
  protected readonly preview = signal<FilePreview | null | undefined>(undefined);
  private timer: ReturnType<typeof setTimeout> | undefined;

  protected readonly url = computed(() => {
    const base = repositoryWebUrl(this.store.currentProject()?.gitRemote);
    const path = this.path();
    if (!base || path.startsWith('/')) return null;
    const ref = encodeURIComponent(this.gitRef() || 'HEAD');
    return `${base}/blob/${ref}/${path.split('/').map(encodeURIComponent).join('/')}`;
  });

  protected enter(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      const box = this.host.nativeElement.getBoundingClientRect();
      const width = Math.min(560, globalThis.innerWidth * 0.8);
      const below = box.bottom + 6;
      this.position.set({
        top: below + 320 > globalThis.innerHeight ? Math.max(8, box.top - 326) : below,
        left: Math.max(8, Math.min(box.left, globalThis.innerWidth - width - 8)),
      });
      this.open.set(true);
      void this.load();
    }, HOVER_DELAY_MS);
  }

  protected leave(): void {
    clearTimeout(this.timer);
    this.open.set(false);
  }

  private async load(): Promise<void> {
    const slug = this.store.activeProject();
    const key = `${slug}:${this.path()}`;
    if (!previews.has(key)) {
      previews.set(
        key,
        this.api
          .get<FilePreview>(`${this.api.projectPath(slug)}/file?path=${encodeURIComponent(this.path())}`)
          .catch(() => null),
      );
    }
    this.preview.set(await previews.get(key)!);
  }
}
