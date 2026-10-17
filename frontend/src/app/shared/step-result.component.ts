import { DatePipe } from '@angular/common';
import { Component, input } from '@angular/core';
import type { StepEvent } from '../core/models.js';
import { AgentOutputPipe } from './agent-output.pipe.js';

/** Gemeinsame Ergebnisansicht eines Agent-Schritts: Live-Meldung, Verlauf mit Uhrzeit und Ausgabe. */
@Component({
  selector: 'app-step-result',
  standalone: true,
  imports: [DatePipe, AgentOutputPipe],
  templateUrl: './step-result.component.html',
})
export class StepResultComponent {
  readonly events = input<StepEvent[] | undefined>([]);
  readonly output = input('');
  readonly progress = input<string | null | undefined>(null);
  readonly running = input(false);
  readonly eventsOpen = input(false);
}
