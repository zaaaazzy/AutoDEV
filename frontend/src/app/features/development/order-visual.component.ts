import { Component, computed, inject, input, signal } from '@angular/core';
import { ApiService } from '../../core/api.service.js';
import type { DevelopmentItem, VisualApproval, VisualDevice, VisualSnapshot } from '../../core/models.js';
import { ProjectStore } from '../../core/project-store.js';
import { DateTimePipe } from '../../shared/pipes.js';

export interface VisualPage {
  page: string;
  after: VisualSnapshot;
  before: VisualSnapshot | null;
  diff: VisualSnapshot | null;
}

/**
 * Je Seite die neueste Aufnahme des Auftrags auf dem gewählten Gerät, dazu der Vorher-Stand (Basis des Vergleichs,
 * oft aus einem früheren Auftrag) und das Diff-Bild.
 */
export function visualPages(snapshots: VisualSnapshot[], orderId: string, device: VisualDevice): VisualPage[] {
  const own = snapshots.filter((shot) => shot.developmentId === orderId && shot.device === device);
  const latest = new Map<string, VisualSnapshot>();
  for (const shot of own.filter((entry) => entry.kind === 'shot')) {
    const known = latest.get(shot.page);
    if (!known || known.createdAt <= shot.createdAt) latest.set(shot.page, shot);
  }
  return [...latest.values()].map((after) => ({
    page: after.page,
    after,
    before: after.baseId ? (snapshots.find((shot) => shot.id === after.baseId) ?? null) : null,
    diff:
      own
        .filter((shot) => shot.kind === 'diff' && shot.page === after.page && shot.baseId === after.baseId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null,
  }));
}

/** Reiter „Ansicht“: Vorher, Nachher und Diff je Seite, Umschalter Desktop/Handy und „Optisch freigeben“. */
@Component({
  selector: 'app-order-visual',
  standalone: true,
  imports: [DateTimePipe],
  template: `
    <details class="run-step order-brief order-visual" (toggle)="toggled($event)">
      <summary>
        Ansicht
        @if (approval().approvedAt) {
          <span class="tag visual-approved">✓ optisch freigegeben</span>
        }
      </summary>
      @if (loading()) {
        <p class="muted">Screenshots werden geladen …</p>
      } @else if (error()) {
        <p class="muted">{{ error() }}</p>
      } @else if (!snapshots().length) {
        <p class="muted">
          Noch keine Screenshots. Die visuelle Prüfung nimmt nach dem Tester die Seiten der Vorschau auf (Einstellungen
          → Visuelle Prüfung: Vorschau-Adresse und Seiten).
        </p>
      } @else {
        <div class="visual-toolbar">
          <div class="segmented" role="group" aria-label="Gerät">
            <button type="button" [class.active]="device() === 'desktop'" (click)="device.set('desktop')">
              Desktop
            </button>
            <button type="button" [class.active]="device() === 'mobile'" (click)="device.set('mobile')">Handy</button>
          </div>
        </div>
        @for (entry of pages(); track entry.page) {
          <section class="visual-page">
            <h4>
              {{ entry.page }}
              @if (entry.after.diffPercent !== null) {
                <span class="muted">· {{ percent(entry.after.diffPercent) }} geändert</span>
              } @else {
                <span class="muted">· erster Stand</span>
              }
            </h4>
            <div class="visual-grid">
              <figure>
                <figcaption>Vorher</figcaption>
                @if (entry.before) {
                  <a [href]="image(entry.before)" target="_blank" rel="noopener"
                    ><img [src]="image(entry.before)" alt="Vorher: {{ entry.page }}" loading="lazy"
                  /></a>
                } @else {
                  <p class="muted">Kein früherer Stand</p>
                }
              </figure>
              <figure>
                <figcaption>Nachher</figcaption>
                <a [href]="image(entry.after)" target="_blank" rel="noopener"
                  ><img [src]="image(entry.after)" alt="Nachher: {{ entry.page }}" loading="lazy"
                /></a>
              </figure>
              <figure>
                <figcaption>Diff</figcaption>
                @if (entry.diff) {
                  <a [href]="image(entry.diff)" target="_blank" rel="noopener"
                    ><img [src]="image(entry.diff)" alt="Unterschiede: {{ entry.page }}" loading="lazy"
                  /></a>
                } @else {
                  <p class="muted">Ab dem zweiten Lauf</p>
                }
              </figure>
            </div>
          </section>
        } @empty {
          <p class="muted">Für dieses Gerät gibt es keine Aufnahmen.</p>
        }
      }
      <div class="actions visual-approval">
        @if (approval().approvedAt) {
          <span
            >✓ Optisch freigegeben von {{ approval().approvedBy || 'Unbekannt' }} am
            {{ approval().approvedAt | dateTime }}</span
          >
          <button class="button secondary small" type="button" [disabled]="busy()" (click)="approve(false)">
            Freigabe zurücknehmen
          </button>
        } @else {
          <button class="button primary" type="button" [disabled]="busy()" (click)="approve(true)">
            ✓ Optisch freigeben
          </button>
        }
      </div>
    </details>
  `,
})
export class OrderVisualComponent {
  private readonly api = inject(ApiService);
  private readonly store = inject(ProjectStore);

  readonly order = input.required<DevelopmentItem>();
  protected readonly snapshots = signal<VisualSnapshot[]>([]);
  protected readonly loaded = signal<VisualApproval | null>(null);
  protected readonly loading = signal(false);
  protected readonly error = signal('');
  protected readonly busy = this.store.busy;
  protected readonly device = signal<VisualDevice>('desktop');
  protected readonly pages = computed(() => visualPages(this.snapshots(), this.order().id, this.device()));
  /** Geladene Freigabe, sonst der Stand aus der Auftragsliste. */
  protected readonly approval = computed<VisualApproval>(
    () =>
      this.loaded() ?? {
        approvedAt: this.order().visualApprovedAt ?? null,
        approvedBy: this.order().visualApprovedBy ?? null,
      },
  );

  protected toggled(event: Event): void {
    if ((event.target as HTMLDetailsElement).open) void this.load();
  }

  private path(): string {
    return `/api/development/${encodeURIComponent(this.order().id)}/visual`;
  }

  private async load(): Promise<void> {
    this.loading.set(true);
    this.error.set('');
    try {
      const result = await this.api.get<{ snapshots: VisualSnapshot[]; approval: VisualApproval }>(this.path());
      this.snapshots.set(result.snapshots);
      this.loaded.set(result.approval);
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.loading.set(false);
    }
  }

  protected image(snapshot: VisualSnapshot): string {
    return this.api.url(`/api/visual-snapshots/${encodeURIComponent(snapshot.id)}`);
  }

  protected percent(value: number): string {
    return `${value.toLocaleString('de-CH', { maximumFractionDigits: 2 })} %`;
  }

  /** Speichert Person und Zeitpunkt der optischen Freigabe am Auftrag (oder nimmt sie zurück). */
  protected approve(approved: boolean): Promise<void> {
    return this.store.perform(
      async () => {
        const result = await this.api.post<{ approval: VisualApproval }>(`${this.path()}/approve`, { approved });
        this.loaded.set(result.approval);
      },
      approved ? 'Optisch freigegeben.' : 'Optische Freigabe zurückgenommen.',
    );
  }
}
