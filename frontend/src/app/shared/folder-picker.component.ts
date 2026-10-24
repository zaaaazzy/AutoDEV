import { Component, inject, input, output, signal } from '@angular/core';
import { SetupService } from '../core/setup.service.js';

interface FolderListing {
  path: string | null;
  parent: string | null;
  roots: string[];
  folders: { name: string; path: string; git: boolean }[];
  selectable: boolean;
  reason: string | null;
}

/**
 * Ordnerauswahl für den Projektordner: blättert auf dem Rechner (über den Worker) durch die Ordner im Projektbereich.
 */
@Component({
  selector: 'app-folder-picker',
  standalone: true,
  template: `
    <button class="button secondary" type="button" [disabled]="loading()" (click)="toggle()">
      📁 {{ open() ? 'Auswahl schliessen' : 'Ordner wählen' }}
    </button>
    @if (open()) {
      <div class="folder-picker">
        <div class="folder-picker-head">
          @if (listing()?.path; as path) {
            <button class="link-button" type="button" [disabled]="loading()" (click)="go(listing()?.parent ?? null)">
              ↑ {{ listing()?.parent ? 'Eine Ebene höher' : 'Projektbereiche' }}
            </button>
            <code>{{ path }}</code>
          } @else {
            <strong>Projektbereich</strong>
          }
        </div>
        @if (error()) {
          <p class="folder-picker-error">{{ error() }}</p>
        }
        @if (loading()) {
          <p class="muted">Ordner werden gelesen …</p>
        } @else if (listing(); as current) {
          @if (current.folders.length) {
            <ul class="folder-picker-list plain-list">
              @for (folder of current.folders; track folder.path) {
                <li>
                  <button class="link-button" type="button" (click)="go(folder.path)">📁 {{ folder.name }}</button>
                  @if (folder.git) {
                    <span class="folder-picker-git">Git</span>
                  }
                </li>
              }
            </ul>
          } @else {
            <p class="muted">Keine Unterordner.</p>
          }
          @if (current.path) {
            <div class="folder-picker-actions">
              <button
                class="button primary"
                type="button"
                [disabled]="!current.selectable"
                (click)="choose(current.path)"
              >
                Diesen Ordner wählen
              </button>
              @if (!current.selectable && current.reason) {
                <span class="muted">{{ current.reason }}</span>
              }
            </div>
          }
        }
      </div>
    }
  `,
})
export class FolderPickerComponent {
  private readonly setup = inject(SetupService);
  /** Aktueller Projektordner: die Auswahl öffnet beim übergeordneten Ordner. */
  readonly value = input('');
  readonly picked = output<string>();

  protected readonly open = signal(false);
  protected readonly loading = signal(false);
  protected readonly error = signal('');
  protected readonly listing = signal<FolderListing | null>(null);

  protected async toggle(): Promise<void> {
    if (this.open()) {
      this.open.set(false);
      return;
    }
    this.open.set(true);
    const current = this.value().trim().replace(/\/+$/, '');
    const parent = current.includes('/') ? current.slice(0, current.lastIndexOf('/')) : '';
    // Liegt der bisherige Ordner nicht mehr im Bereich (z. B. Laufwerk gewechselt), mit der Übersicht beginnen.
    if (!(await this.go(parent || null, true))) await this.go(null);
  }

  protected async go(path: string | null, quiet = false): Promise<boolean> {
    this.loading.set(true);
    this.error.set('');
    try {
      const job = await this.setup.run<FolderListing>('list_folders', { path: path ?? '' });
      if (job.status !== 'done' || !job.result)
        throw new Error(job.result?.error ?? 'Ordner konnten nicht gelesen werden.');
      this.listing.set(job.result);
      return true;
    } catch (error) {
      if (!quiet) this.error.set(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      this.loading.set(false);
    }
  }

  protected choose(path: string): void {
    this.picked.emit(path);
    this.open.set(false);
  }
}
