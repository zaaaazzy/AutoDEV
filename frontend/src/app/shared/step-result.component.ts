import { DatePipe } from '@angular/common';
import { Component, input } from '@angular/core';
import type { StepEvent } from '../core/models.js';
import { MarkdownPipe } from './markdown.pipe.js';

/** Gemeinsame Ergebnisansicht eines Agent-Schritts: Live-Meldung, Verlauf mit Uhrzeit und Ausgabe. */
@Component({
  selector: 'app-step-result',
  standalone: true,
  imports: [DatePipe, MarkdownPipe],
  templateUrl: './step-result.component.html',
})
export class StepResultComponent {
  readonly events = input<StepEvent[] | undefined>([]);
  readonly output = input('');
  readonly progress = input<string | null | undefined>(null);
  readonly running = input(false);
  readonly eventsOpen = input(false);
}
