import { Component, computed, inject } from '@angular/core';
import type { TestCategory, TestRun } from '../../core/models.js';
import { ProjectStore } from '../../core/project-store.js';
import { ShareBarComponent, type ShareSegment } from '../../shared/share-bar.component.js';
import { DateTimePipe } from '../../shared/pipes.js';

/** Testarten in der Reihenfolge der Pyramide; „Benutzertests“ ist der vollständige UI-Durchlauf mit Aufnahmen. */
const METHODS: { id: TestCategory; label: string }[] = [
  { id: 'quality', label: 'Qualität (Lint, Typen, Build)' },
  { id: 'unit', label: 'Unit- und Integrationstests' },
  { id: 'e2e', label: 'Oberflächentests' },
  { id: 'user', label: 'Benutzertests (vollständiger UI-Durchlauf)' },
];

/** Letzter Testlauf je Testart als Anteilsbalken; ein Klick öffnet die Testläufe. */
@Component({
  selector: 'app-test-methods-panel',
  standalone: true,
  imports: [ShareBarComponent, DateTimePipe],
  template: `
    <article class="panel">
      <div class="section-heading">
        <h2>Tests nach Art</h2>
        <a href="#runs" (click)="$event.preventDefault(); store.navigate('runs')">Alle Testläufe</a>
      </div>
      @if (latest(); as run) {
        <p class="muted small">Letzter Lauf {{ run.startedAt | dateTime }}</p>
        <div class="share-stack compact">
          @for (method of methods(); track method.id) {
            <app-share-bar
              [label]="method.label"
              [link]="{ section: 'runs' }"
              [segments]="method.segments"
              [legend]="false"
              [showTotal]="true"
            />
          } @empty {
            <p class="empty-state">Dieser Lauf enthält noch keine Einzelergebnisse.</p>
          }
        </div>
        <div class="share-legend static">
          <span class="share-key"><span class="share-dot tone-ok"></span>Bestanden</span>
          <span class="share-key"><span class="share-dot tone-bad"></span>Fehlgeschlagen</span>
          <span class="share-key"><span class="share-dot tone-wait"></span>Wackelig</span>
          <span class="share-key"><span class="share-dot tone-neutral"></span>Übersprungen</span>
        </div>
      } @else {
        <p class="empty-state">Noch keine Testläufe vorhanden.</p>
      }
    </article>
  `,
  host: { style: 'display: contents' },
})
export class TestMethodsPanelComponent {
  protected readonly store = inject(ProjectStore);
  protected readonly latest = computed<TestRun | null>(() => this.store.data().runs[0] ?? null);

  protected readonly methods = computed(() => {
    const run = this.latest();
    if (!run) return [];
    const link = { section: 'runs' };
    return METHODS.map((method) => {
      // Einzeltests, wo vorhanden; sonst (Qualität, ältere Läufe) die Befehle dieser Art.
      const cases = run.summary?.[method.id];
      const counts: Record<string, number> =
        cases && Object.keys(cases).length
          ? cases
          : run.steps
              .filter((step) => step.category === method.id)
              .reduce<Record<string, number>>((all, step) => {
                const key = step.status === 'passed' ? 'passed' : 'failed';
                all[key] = (all[key] ?? 0) + 1;
                return all;
              }, {});
      const segments: ShareSegment[] = [
        { label: 'Bestanden', value: counts['passed'] ?? 0, tone: 'ok', link },
        { label: 'Fehlgeschlagen', value: counts['failed'] ?? 0, tone: 'bad', link },
        { label: 'Wackelig', value: counts['flaky'] ?? 0, tone: 'wait', link },
        { label: 'Übersprungen', value: counts['skipped'] ?? 0, tone: 'neutral', link },
      ];
      return { ...method, segments };
    }).filter((method) => method.segments.some((segment) => segment.value > 0));
  });
}
