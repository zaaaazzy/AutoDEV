import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { ApiService } from '../../core/api.service.js';
import { errorMessage } from '../../core/errors.js';
import { ProjectStore } from '../../core/project-store.js';
import {
  DataCellDirective,
  type DataColumn,
  DataTableComponent,
} from '../../shared/data-table/data-table.component.js';
import { categoryColumn } from '../../shared/data-table/columns.js';
import { formatHours, formatMoney, formatNumber } from '../../shared/format.js';
import type { BudgetOverview, ProjectStats } from '../../core/models.js';
import { errorText, estimateTrend } from './estimate-trend.js';
import { BudgetMeterComponent } from '../../shared/budget-meter.component.js';
import { categoryLabel } from '../../shared/labels.js';
import { DateTimePipe, HoursPipe, LocaleNumberPipe } from '../../shared/pipes.js';
import { CHART_HEIGHT, CHART_WIDTH, chartY, COVERAGE_TARGET, coverageSeries } from './coverage-history.js';
import { QualityPanelComponent } from './quality-panel.component.js';
import { CoverageTrendComponent } from './coverage-trend.component.js';
import { calibrationText, hitRateText } from './stats-text.js';

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
  /** Verbrauch je Modell und geschätzte Ersparnis durch das Routing (null = noch kein Preis gemessen). */
  routing?: {
    routedSteps: number;
    localTokens: number;
    savedUsd: number | null;
    byModel: { model: string; count: number; routed: number; tokens: number; costUsd: number }[];
  };
}
interface PromptEntry {
  id: string;
  agent: string;
  prompt: string;
  tokens: number;
  createdAt: string;
  success: boolean;
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

type SprintVelocity = ProjectStats['velocity'][number];

/** Verbrauch nach Bereich, Art, Auftrag (Schätzung gegen tatsächlich) und Agent. */
@Component({
  selector: 'app-stats',
  standalone: true,
  imports: [
    DataTableComponent,
    DataCellDirective,
    HoursPipe,
    LocaleNumberPipe,
    QualityPanelComponent,
    CoverageTrendComponent,
    BudgetMeterComponent,
    DateTimePipe,
  ],
  templateUrl: './stats.component.html',
  host: { style: 'display: contents' },
})
export class StatsComponent {
  private readonly api = inject(ApiService);
  protected readonly store = inject(ProjectStore);
  protected readonly usage = signal<ProjectUsage | null>(null);
  protected readonly budget = signal<BudgetOverview | null>(null);
  protected readonly prompts = signal<PromptEntry[]>([]);
  protected readonly error = signal('');
  protected readonly coverage = computed(() => coverageSeries(this.store.data().coverage?.history ?? []));
  protected readonly chart = { width: CHART_WIDTH, height: CHART_HEIGHT, target: chartY(COVERAGE_TARGET) };
  protected readonly coverageTarget = COVERAGE_TARGET;
  protected readonly ratioText = ratioText;
  protected readonly shortRatio = shortRatio;
  protected readonly errorText = errorText;
  protected readonly estimateTrend = computed(() => estimateTrend(this.store.data().stats?.velocity ?? []));
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
  protected readonly calibrationText = calibrationText;
  protected readonly sprints = computed(() => this.store.data().stats?.velocity ?? []);
  protected readonly calibration = computed(() => this.store.data().stats?.calibration ?? []);

  protected readonly sprintColumns: DataColumn<SprintVelocity>[] = [
    { id: 'name', header: 'Sprint', value: (row) => row.name, className: 'title-cell', filter: 'text' },
    {
      id: 'done',
      header: 'Erledigt',
      value: (row) => `${row.done} von ${row.total}`,
      sortValue: (row) => row.done,
      filter: false,
    },
    {
      id: 'hitRate',
      header: 'Trefferquote',
      value: (row) => hitRateText(row.hitRate),
      sortValue: (row) => row.hitRate?.percent ?? -1,
      filter: false,
    },
  ];
  protected readonly sprintId = (row: SprintVelocity): string => row.id ?? row.name;
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

  protected money(usd: number | null | undefined): string {
    return formatMoney(usd, this.budget());
  }

  private async load(slug: string): Promise<void> {
    try {
      this.error.set('');
      const usage = await this.api.get<ProjectUsage>(`${this.api.projectPath(slug)}/usage`);
      if (!this.store.isActive(slug)) return;
      this.usage.set(usage);
    } catch (error) {
      if (!this.store.isActive(slug)) return;
      this.error.set(errorMessage(error, 'Statistik konnte nicht geladen werden.'));
    }
    // Budget und Prompt-Protokoll sind Zusatz: ohne sie bleibt die Statistik vollständig.
    const budget = await this.api.get<BudgetOverview>(`${this.api.projectPath(slug)}/budget`).catch(() => null);
    if (!this.store.isActive(slug)) return;
    this.budget.set(budget);
    const { prompts } = await this.api
      .get<{ prompts: PromptEntry[] }>(`${this.api.projectPath(slug)}/usage/prompts?role=author`)
      .catch(() => ({ prompts: [] }));
    if (this.store.isActive(slug)) this.prompts.set(prompts);
  }
}
