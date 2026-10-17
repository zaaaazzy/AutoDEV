import { NgClass, NgTemplateOutlet } from '@angular/common';
import { Component, contentChild, input, signal, TemplateRef } from '@angular/core';
import { ModelIconComponent } from './model-icon.component.js';
import { StatusClassPipe, StatusLabelPipe } from './pipes.js';

export interface AgentTableRow {
  key: string;
  name: string;
  /** Agent-Befehl für das Modell-Symbol; leer = lokales Modell. */
  command?: readonly string[] | null;
  status: string;
  /** Kurze Zusatzinfo unter dem Namen, z. B. Rolle oder aktueller Auftrag. */
  hint?: string | null;
}

/**
 * Agents als Tabelle im Stil der Auftragsliste: Modell-Symbol, Name, Status und Aufklapp-Pfeil ganz rechts.
 * Den Inhalt der aufgeklappten Zeile liefert die einbettende Ansicht als <ng-template let-row>.
 */
@Component({
  selector: 'app-agent-table',
  standalone: true,
  imports: [NgClass, NgTemplateOutlet, ModelIconComponent, StatusClassPipe, StatusLabelPipe],
  templateUrl: './agent-table.component.html',
})
export class AgentTableComponent<Row extends AgentTableRow = AgentTableRow> {
  readonly rows = input.required<Row[]>();
  readonly empty = input('Keine Agents vorhanden.');
  protected readonly detail = contentChild(TemplateRef<{ $implicit: Row }>);
  protected readonly openKey = signal<string | null>(null);

  protected toggle(key: string): void {
    this.openKey.update((current) => (current === key ? null : key));
  }
}
