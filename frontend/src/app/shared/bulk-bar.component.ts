import { Component, input, output } from '@angular/core';

/**
 * Schmale Leiste über einer Liste mit Mehrfachauswahl: Anzahl, die Sammelaktionen der Liste (als Inhalt) und
 * „Auswahl aufheben“. Eine Zeile hoch, damit die Liste darunter nicht springt.
 */
@Component({
  selector: 'app-bulk-bar',
  standalone: true,
  template: `
    <div class="bulk-bar compact" role="region" aria-label="Auswahl">
      <!-- &ngsp; hält das Leerzeichen, damit Vorlesen und Kopieren „2 Aufträge“ statt „2Aufträge“ ergeben. -->
      <span class="bulk-count">{{ count() }}</span
      >&ngsp;<strong class="bulk-label">{{ count() === 1 ? one() : many() }} ausgewählt</strong>
      <span class="bulk-actions"><ng-content /></span>
      <button type="button" class="button secondary small" (click)="cleared.emit()">Auswahl aufheben</button>
    </div>
  `,
})
export class BulkBarComponent {
  readonly count = input.required<number>();
  readonly one = input('Eintrag');
  readonly many = input('Einträge');
  readonly cleared = output<void>();
}
