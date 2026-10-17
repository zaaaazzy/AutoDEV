import { Component, input } from '@angular/core';
import { GalleryComponent } from './gallery.component.js';
import { MarkdownPipe } from './markdown.pipe.js';
import { PriorityLabelPipe } from './pipes.js';

/** Einheitliche, aufklappbare Anzeige eines Auftragstexts (Ziel, Anforderungen …) mit Bildern. */
@Component({
  selector: 'app-order-brief',
  standalone: true,
  imports: [GalleryComponent, MarkdownPipe, PriorityLabelPipe],
  template: `
    <details class="run-step order-brief" [open]="open()">
      <summary>Auftrag</summary>
      @if (description()) {
        <article class="markdown" [innerHTML]="description() | markdown"></article>
      } @else {
        <p class="muted">Keine Beschreibung.</p>
      }
      @if (priority(); as level) {
        <p class="muted">Priorität: {{ level | priorityLabel }}</p>
      }
      @if (ideationId() || bugId()) {
        <app-gallery [ideationId]="ideationId()" [bugId]="bugId()" />
      }
    </details>
  `,
  host: { style: 'display: contents' },
})
export class OrderBriefComponent {
  readonly description = input<string | null | undefined>('');
  readonly priority = input<string | null | undefined>(null);
  readonly ideationId = input<string | null | undefined>(null);
  readonly bugId = input<string | null | undefined>(null);
  readonly open = input(false);
}
