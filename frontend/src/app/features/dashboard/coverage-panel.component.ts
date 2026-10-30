import { DatePipe, DecimalPipe } from '@angular/common';
import { Component, computed, inject } from '@angular/core';
import { COVERAGE_AREA_LABELS } from '../../../../../src/core/coverage-areas.js';
import type { CoverageArea } from '../../core/models.js';
import { ProjectStore } from '../../core/project-store.js';
import { MarkdownPipe } from '../../shared/markdown.pipe.js';

/** Ab dieser Zeilenabdeckung gilt ein Bereich als ausreichend getestet (wie beim Tester). */
const TARGET = 75;

/**
 * Testabdeckung und Anzahl Tests je Bereichsschlüssel und Testart: je Schlüssel eine Zeile mit dem neuesten
 * vollständigen Lauf und dessen Datum. Eine Summenzeile gibt es nicht; „Gesamt“ erscheint nur, wenn ein Lauf es meldet.
 */
@Component({
  selector: 'app-coverage-panel',
  standalone: true,
  imports: [DatePipe, DecimalPipe, MarkdownPipe],
  templateUrl: './coverage-panel.component.html',
  host: { style: 'display: contents' },
})
export class CoveragePanelComponent {
  private readonly store = inject(ProjectStore);
  protected readonly report = computed(() => this.store.data().coverage);
  protected readonly target = TARGET;
  protected readonly metrics: {
    key: 'lines' | 'statements' | 'branches' | 'functions';
    label: string;
    hint: string;
  }[] = [
    { key: 'lines', label: 'Zeilen', hint: 'Zeilenabdeckung (Line Coverage)' },
    { key: 'statements', label: 'Anweisungen', hint: 'Anweisungsabdeckung (Statement Coverage)' },
    { key: 'branches', label: 'Zweige', hint: 'Zweigabdeckung (Branch Coverage)' },
    { key: 'functions', label: 'Funktionen', hint: 'Funktionsabdeckung (Function Coverage)' },
  ];

  protected readonly label = (area: CoverageArea): string => COVERAGE_AREA_LABELS[area.area] ?? area.area;

  protected count(area: CoverageArea): number {
    return area.unit + area.component + area.integration + area.e2e;
  }

  protected tone(value: number | null): string {
    if (value === null) return 'none';
    return value >= TARGET ? 'good' : value >= 50 ? 'warn' : 'bad';
  }
}
