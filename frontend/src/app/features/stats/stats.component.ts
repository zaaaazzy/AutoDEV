import { Component, effect, inject, signal, untracked } from '@angular/core';
import { ApiService } from '../../core/api.service.js';
import { errorMessage } from '../../core/errors.js';
import { ProjectStore } from '../../core/project-store.js';
import {
  DataCellDirective,
  type DataColumn,
  DataTableComponent,
} from '../../shared/data-table/data-table.component.js';
import { categoryColumn } from '../../shared/data-table/columns.js';
import { formatHours, formatNumber } from '../../shared/format.js';
import { categoryLabel } from '../../shared/labels.js';
import { HoursPipe, LocaleNumberPipe } from '../../shared/pipes.js';
import { QualityPanelComponent } from './quality-panel.component.js';

interface Usage {
  tokens: number;
  hours: number;
  costUsd: number;
}
interface UsageGroup {
  key: string;
  count: number;
  actual: Usage;
  estimate: { hours: number; tokens: number };
}
interface OrderUsage {
  id: string;
  title: string;
  kind: string;
  category: string | null;
  status: string;
  runs: number;
  estimate: { hours: number | null; tokens: number | null };
  actual: Usage;
}
interface AgentUsage {
  agent: string;
  source: 'workflow' | 'system';
  count: number;
  failed: number;
  successRate: number | null;
  actual: Usage;
  avgTokens: number;
  avgSeconds: number;
  share: number;
}
interface ProjectUsage {
  totals: Usage & { estimateTokens: number; estimateActualTokens: number };
  byCategory: UsageGroup[];
  byKind: UsageGroup[];
  orders: OrderUsage[];
  agents: AgentUsage[];
}

const KIND_LABELS: Record<string, string> = {
  order: 'Aufträge',
  bug: 'Bug-Aufträge',
  dashboard: 'Dashboard-Assistent',
  planning: 'Planung (Auftragsautor, Bug-Wächter, Analyse)',
};

/** Faktor tatsächlich/geschätzt als lesbarer Text („3 % der Schätzung“ bzw. „2,1× der Schätzung“). */
export function ratioText(actual: number, estimate: number | null | undefined): string {
  if (!estimate || !actual) return '–';
  const ratio = actual / estimate;
  return ratio < 1
    ? `${formatNumber(Math.max(1, Math.round(ratio * 100)))} % der Schätzung`
    : `${ratio.toLocaleString('de-DE', { maximumFractionDigits: 1 })}× der Schätzung`;
}

function shortRatio(actual: number, estimate: number | null | undefined): string {
  if (!estimate || !actual) return '–';
  const ratio = actual / estimate;
  return ratio < 1
    ? `${Math.max(1, Math.round(ratio * 100))} %`
    : `${ratio.toLocaleString('de-DE', { maximumFractionDigits: 1 })}×`;
}

/** Verbrauch nach Bereich, Art, Auftrag (Schätzung gegen tatsächlich) und Agent. */
@Component({
  selector: 'app-stats',
  standalone: true,
  imports: [DataTableComponent, DataCellDirective, HoursPipe, LocaleNumberPipe, QualityPanelComponent],
  templateUrl: './stats.component.html',
  host: { style: 'display: contents' },
})
export class StatsComponent {
  private readonly api = inject(ApiService);
  protected readonly store = inject(ProjectStore);
  protected readonly usage = signal<ProjectUsage | null>(null);
  protected readonly error = signal('');
  protected readonly ratioText = ratioText;
  protected readonly kindLabel = (key: string): string => KIND_LABELS[key] ?? key;
  protected readonly categoryLabel = (key: string): string => (key === 'none' ? 'Ohne Bereich' : categoryLabel(key));

  protected readonly orderColumns: DataColumn<OrderUsage>[] = [
    { id: 'title', header: 'Auftrag', value: (row) => row.title, className: 'title-cell', filter: 'text' },
    {
      id: 'kind',
      header: 'Art',
      value: (row) => (row.kind === 'bug' ? 'Bug' : row.kind === 'express' ? 'Express' : 'Auftrag'),
      filter: 'select',
    },
    categoryColumn((row) => row.category),
    {
      id: 'estTokens',
      header: 'Tokens Schätzung',
      value: (row) => (row.estimate.tokens === null ? '–' : formatNumber(row.estimate.tokens)),
      sortValue: (row) => row.estimate.tokens ?? -1,
      filter: false,
    },
    {
      id: 'tokens',
      header: 'Tokens Ist',
      value: (row) => formatNumber(row.actual.tokens),
      sortValue: (row) => row.actual.tokens,
      filter: false,
    },
    {
      id: 'hours',
      header: 'Stunden Schätzung/Ist',
      value: (row) => `${formatHours(row.estimate.hours)} / ${formatHours(row.actual.hours)}`,
      sortValue: (row) => row.actual.hours,
      filter: false,
    },
    {
      id: 'ratio',
      header: 'Ist/Schätzung',
      value: (row) => shortRatio(row.actual.tokens, row.estimate.tokens),
      sortValue: (row) => (row.estimate.tokens ? row.actual.tokens / row.estimate.tokens : -1),
      filter: false,
    },
    { id: 'runs', header: 'Läufe', value: (row) => row.runs, filter: false },
  ];

  protected readonly agentColumns: DataColumn<AgentUsage>[] = [
    { id: 'agent', header: 'Agent', value: (row) => row.agent, className: 'title-cell', filter: 'text' },
    {
      id: 'source',
      header: 'Einsatz',
      value: (row) => (row.source === 'workflow' ? 'Auftrags-Workflow' : 'System'),
      filter: 'select',
    },
    { id: 'count', header: 'Einsätze', value: (row) => row.count, filter: false },
    {
      id: 'success',
      header: 'Erfolgsquote',
      value: (row) => (row.successRate === null ? '–' : `${row.successRate} %`),
      sortValue: (row) => row.successRate ?? -1,
      filter: false,
    },
    {
      id: 'share',
      header: 'Anteil Tokens',
      value: (row) => `${row.share} %`,
      sortValue: (row) => row.share,
      filter: false,
    },
    {
      id: 'tokens',
      header: 'Tokens',
      value: (row) => formatNumber(row.actual.tokens),
      sortValue: (row) => row.actual.tokens,
      filter: false,
    },
    {
      id: 'avgTokens',
      header: 'Ø Tokens',
      value: (row) => formatNumber(row.avgTokens),
      sortValue: (row) => row.avgTokens,
      filter: false,
    },
    {
      id: 'avgSeconds',
      header: 'Ø Dauer',
      value: (row) => (row.avgSeconds >= 60 ? `${Math.round(row.avgSeconds / 60)} min` : `${row.avgSeconds} s`),
      sortValue: (row) => row.avgSeconds,
      filter: false,
    },
  ];
  protected readonly orderId = (row: OrderUsage): string => row.id;
  protected readonly agentId = (row: AgentUsage): string => `${row.source}-${row.agent}`;

  constructor() {
    effect(() => {
      const slug = this.store.activeProject();
      this.store.foregroundLoads();
      if (slug) untracked(() => void this.load(slug));
    });
  }

  protected share(value: number, groups: UsageGroup[]): number {
    const max = Math.max(1, ...groups.map((group) => group.actual.tokens));
    return Math.round((value / max) * 100);
  }

  private async load(slug: string): Promise<void> {
    try {
      this.error.set('');
      this.usage.set(await this.api.get<ProjectUsage>(`${this.api.projectPath(slug)}/usage`));
    } catch (error) {
      this.error.set(errorMessage(error, 'Statistik konnte nicht geladen werden.'));
    }
  }
}
