import { Component, computed, inject, input } from '@angular/core';
import { ProjectStore } from '../core/project-store.js';

/** Ziel eines Klicks: Seite, optional mit Tabellenfiltern (Werte wie in der Tabelle angezeigt) und Abschnitt. */
export interface ShareLink {
  section: string;
  filters?: Record<string, string[]>;
  anchor?: string;
  /** Statt Navigation eine eigene Aktion, z. B. Agent öffnen. */
  action?: () => void;
}

export interface ShareSegment {
  label: string;
  value: number;
  /** Farbton: ok, active, wait, warn, bad, neutral, info, plain */
  tone: string;
  link?: ShareLink;
}

/**
 * Einheitliche Darstellung für Anteile: ein Balken = 100 %, jede Kategorie ein farbiger Abschnitt.
 * Abschnitte und Legende sind klickbar und öffnen die passende Seite mit gesetztem Filter.
 */
@Component({
  selector: 'app-share-bar',
  standalone: true,
  template: `
    @if (showTotal() || label()) {
      <div class="share-head">
        @if (label()) {
          <button type="button" class="share-label link-button" [disabled]="!link()" (click)="go(link())">
            {{ label() }}
          </button>
        }
        @if (showTotal()) {
          <strong class="share-total">{{ suffix() ? total() + ' ' + suffix() : total() }}</strong>
        }
      </div>
    }
    <div class="share-bar" [class.empty]="!total()" role="group" [attr.aria-label]="label() || 'Anteile'">
      @for (segment of visible(); track segment.label) {
        <button
          type="button"
          [class]="'share-seg tone-' + segment.tone"
          [style.flex-grow]="segment.value"
          [title]="segment.label + ': ' + segment.value + ' (' + percent(segment.value) + '%)'"
          [attr.aria-label]="segment.label + ': ' + segment.value"
          (click)="go(segment.link)"
        ></button>
      }
    </div>
    @if (legend()) {
      <div class="share-legend">
        @for (segment of segments(); track segment.label) {
          <button type="button" class="share-key" [class.zero]="!segment.value" (click)="go(segment.link)">
            <span [class]="'share-dot tone-' + segment.tone"></span>
            {{ segment.label }} <strong>{{ segment.value }}</strong>
            @if (total() && segment.value) {
              <small class="muted">{{ percent(segment.value) }}%</small>
            }
          </button>
        }
      </div>
    }
  `,
  host: { class: 'share' },
})
export class ShareBarComponent {
  private readonly store = inject(ProjectStore);
  readonly segments = input.required<ShareSegment[]>();
  readonly label = input('');
  /** Klickziel des Titels (ganze Kategorie ohne Filter). */
  readonly link = input<ShareLink | undefined>(undefined);
  readonly legend = input(true);
  readonly showTotal = input(false);
  readonly suffix = input('');

  protected readonly total = computed(() => this.segments().reduce((sum, segment) => sum + segment.value, 0));
  protected readonly visible = computed(() => this.segments().filter((segment) => segment.value > 0));

  protected percent(value: number): number {
    return this.total() ? Math.round((value / this.total()) * 100) : 0;
  }

  protected go(link: ShareLink | undefined): void {
    if (!link) return;
    if (link.action) {
      link.action();
      return;
    }
    this.store.navigate(link.section, { filters: link.filters, anchor: link.anchor });
  }
}
