import { DatePipe, NgTemplateOutlet } from '@angular/common';
import { Component, computed, effect, ElementRef, input, viewChild } from '@angular/core';
import type { StepEvent } from '../core/models.js';
import { AgentOutputPipe } from './agent-output.pipe.js';
import { EventIconComponent } from './event-icon.component.js';
import { FileLinkComponent } from './file-link.component.js';
import { describeStepEvent, summarizeFiles } from './step-event.js';

/** Gemeinsame Ergebnisansicht eines Agent-Schritts: Live-Meldung, Verlauf mit Uhrzeit und Ausgabe. */
@Component({
  selector: 'app-step-result',
  standalone: true,
  imports: [DatePipe, NgTemplateOutlet, AgentOutputPipe, EventIconComponent, FileLinkComponent],
  templateUrl: './step-result.component.html',
})
export class StepResultComponent {
  readonly events = input<StepEvent[] | undefined>([]);
  readonly output = input('');
  readonly progress = input<string | null | undefined>(null);
  readonly running = input(false);
  readonly eventsOpen = input(false);
  /** Kompakte Ansicht (Chat): Ausgabe direkt, Verlauf und Dateien nur nach dem Aufklappen unter der Nachricht. */
  readonly compact = input(false);
  protected readonly describe = describeStepEvent;
  protected readonly files = computed(() => summarizeFiles(this.events() ?? []));
  protected readonly fileGroups = computed(() => {
    const summary = this.files();
    return [
      { title: 'Geschrieben', icon: 'write', items: summary.written },
      { title: 'Gelesen', icon: 'read', items: summary.read },
      { title: 'Ausgeführt', icon: 'run', items: summary.run },
    ].filter((group) => group.items.length);
  });
  /** Neue Einträge nur mitführen, wenn man ohnehin unten im Verlauf steht – sonst springt nichts. */
  private stickToBottom = true;
  private readonly timeline = viewChild<ElementRef<HTMLElement>>('timeline');

  constructor() {
    effect(() => {
      this.events();
      const element = this.timeline()?.nativeElement;
      if (element && this.stickToBottom) queueMicrotask(() => (element.scrollTop = element.scrollHeight));
    });
  }

  protected onTimelineScroll(element: HTMLElement): void {
    this.stickToBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
  }
}
