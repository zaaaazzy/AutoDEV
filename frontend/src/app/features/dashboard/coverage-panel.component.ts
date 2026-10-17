import { DatePipe, DecimalPipe, NgTemplateOutlet } from '@angular/common';
import { Component, computed, inject } from '@angular/core';
import type { CoverageArea } from '../../core/models.js';
import { ProjectStore } from '../../core/project-store.js';
import { MarkdownPipe } from '../../shared/markdown.pipe.js';

/** Ab dieser Zeilenabdeckung gilt ein Bereich als ausreichend getestet (wie beim Tester). */
const TARGET = 75;

/** Testabdeckung und Anzahl Tests je Bereich und Testart, wie vom Tester gemeldet. */
@Component({
  selector: 'app-coverage-panel',
  standalone: true,
  imports: [DatePipe, DecimalPipe, NgTemplateOutlet, MarkdownPipe],
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

  /** Summenzeile über alle Bereiche; Prozentwerte als Mittel der gemeldeten Bereiche. */
  protected readonly total = computed<CoverageArea | null>(() => {
    const areas = this.report()?.areas ?? [];
    if (areas.length < 2) return null;
    const sum = (key: 'unit' | 'component' | 'integration' | 'e2e' | 'passed' | 'failed') =>
      areas.reduce((total, area) => total + area[key], 0);
    const mean = (key: 'lines' | 'statements' | 'branches' | 'functions') => {
      const values = areas.map((area) => area[key]).filter((value): value is number => value !== null);
      return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
    };
    return {
      area: 'Gesamt',
      unit: sum('unit'),
      component: sum('component'),
      integration: sum('integration'),
      e2e: sum('e2e'),
      passed: sum('passed'),
      failed: sum('failed'),
      lines: mean('lines'),
      statements: mean('statements'),
      branches: mean('branches'),
      functions: mean('functions'),
    };
  });

  protected count(area: CoverageArea): number {
    return area.unit + area.component + area.integration + area.e2e;
  }

  protected tone(value: number | null): string {
    if (value === null) return 'none';
    return value >= TARGET ? 'good' : value >= 50 ? 'warn' : 'bad';
  }
}
