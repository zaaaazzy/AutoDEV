import { Component, computed, input } from '@angular/core';
import { type BugCategorySprintPair, bugCategoryMatrix } from './bug-stats.js';

/**
 * Tabelle Kategorie × Sprint: je Zelle offene und begrabene (✝) Bugs. Gleiche Darstellung auf der Bugs-Seite (aus der
 * Bug-Liste) und in der Statistik (aus `bugsByCategorySprint`). Die Gesamtsumme entspricht der Zahl aller Bugs.
 */
@Component({
  selector: 'app-bug-category-matrix',
  standalone: true,
  template: `
    @let table = matrix();
    @if (table.total) {
      <div class="bug-category-matrix">
        <table class="bug-stats-table" aria-label="Bugs je Kategorie und Sprint, offen und begraben">
          <thead>
            <tr>
              <th scope="col">Kategorie</th>
              @for (sprint of table.sprints; track sprint.id) {
                <th scope="col" class="num">{{ sprint.name }}</th>
              }
              <th scope="col" class="num">Summe</th>
            </tr>
          </thead>
          <tbody>
            @for (row of table.rows; track row.label) {
              <tr [class.muted]="!row.total">
                <th scope="row">{{ row.label }}</th>
                @for (cell of row.cells; track $index) {
                  <td class="num" [attr.title]="cell.open + ' offen, ' + cell.buried + ' begraben'">
                    {{ cellText(cell.open, cell.buried) }}
                  </td>
                }
                <td class="num">{{ row.total || '–' }}</td>
              </tr>
            }
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">Summe</th>
              @for (cell of table.totals; track $index) {
                <td class="num">{{ cellText(cell.open, cell.buried) }}</td>
              }
              <td class="num">{{ table.total }}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      <p class="muted">
        Je Zelle offen · ✝ begraben. Nur bestätigte Kategorien zählen; Vorschläge des lokalen Modells stehen bis zur
        Bestätigung unter „Ohne Kategorie“.
      </p>
    } @else {
      <p class="muted">Noch keine Bugs.</p>
    }
  `,
})
export class BugCategoryMatrixComponent {
  readonly pairs = input.required<BugCategorySprintPair[]>();
  protected readonly matrix = computed(() => bugCategoryMatrix(this.pairs()));

  protected cellText(open: number, buried: number): string {
    if (!open && !buried) return '–';
    return buried ? `${open} · ✝${buried}` : String(open);
  }
}
