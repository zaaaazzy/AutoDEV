import { Component, computed, inject, input } from '@angular/core';
import { ProjectStore } from '../core/project-store.js';
import { repositoryWebUrl } from './repository-url.js';

/** Dateipfad als hervorgehobener Link auf die Datei im Git-Repository (z. B. GitHub). */
@Component({
  selector: 'app-file-link',
  standalone: true,
  templateUrl: './file-link.component.html',
  host: { class: 'file-link' },
})
export class FileLinkComponent {
  private readonly store = inject(ProjectStore);
  readonly path = input.required<string>();
  /** Commit oder Branch für den Link; HEAD zeigt den Stand des Standard-Branches. */
  readonly gitRef = input<string | null | undefined>(null);

  /** Ordner und Dateiname getrennt: gekürzt wird nur der Ordner, der Dateiname bleibt immer lesbar. */
  protected readonly parts = computed(() => {
    const path = this.path();
    const cut = path.lastIndexOf('/') + 1;
    // Links-nach-rechts-Marken halten Schrägstriche an ihrem Platz, obwohl der Ordner von links gekürzt wird.
    const dir = path.slice(0, cut);
    return { dir: dir ? `\u200E${dir}\u200E` : '', name: path.slice(cut) };
  });

  protected readonly url = computed(() => {
    const base = repositoryWebUrl(this.store.currentProject()?.gitRemote);
    const path = this.path();
    if (!base || path.startsWith('/')) return null;
    const ref = encodeURIComponent(this.gitRef() || 'HEAD');
    return `${base}/blob/${ref}/${path.split('/').map(encodeURIComponent).join('/')}`;
  });
}
