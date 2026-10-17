import { NgClass, NgTemplateOutlet } from '@angular/common';
import { Component, contentChild, input, TemplateRef } from '@angular/core';
import {
  type DataColumn,
  DataCellDirective,
  DataDetailDirective,
  DataTableComponent,
} from './data-table/data-table.component.js';
import { statusLabel } from './labels.js';
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
  imports: [
    NgClass,
    NgTemplateOutlet,
    DataTableComponent,
    DataCellDirective,
    DataDetailDirective,
    ModelIconComponent,
    StatusClassPipe,
    StatusLabelPipe,
  ],
  templateUrl: './agent-table.component.html',
})
export class AgentTableComponent<Row extends AgentTableRow = AgentTableRow> {
  readonly rows = input.required<Row[]>();
  readonly empty = input('Keine Agents vorhanden.');
  /** Suche über der Tabelle; bei kurzen Workflow-Listen meist aus. */
  readonly searchable = input(false);
  protected readonly detail = contentChild(TemplateRef<{ $implicit: Row }>);
  protected readonly rowKey = (row: Row): string => row.key;
  protected readonly columns: DataColumn<Row>[] = [
    { id: 'name', header: 'Agent', value: (row) => row.name, filter: 'text', className: 'title-cell' },
    { id: 'status', header: 'Status', value: (row) => statusLabel(row.status), sortable: true },
  ];
}
