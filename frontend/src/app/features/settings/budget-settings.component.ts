import { Component, effect, inject, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../core/api.service.js';
import type { BudgetOverview, BudgetPeriod, RoutingRule, RuleEffect } from '../../core/models.js';
import { ProjectStore } from '../../core/project-store.js';
import { BudgetMeterComponent } from '../../shared/budget-meter.component.js';

export const PERIODS: { key: BudgetPeriod; label: string; hint: string }[] = [
  { key: 'day', label: 'Je Tag', hint: 'Agents und Assistent zusammen; wird am Folgetag wieder frei.' },
  { key: 'sprint', label: 'Je Sprint', hint: 'Ab Beginn des aktiven Sprints.' },
  { key: 'order', label: 'Je Auftrag', hint: 'Seit dem letzten „Erneut versuchen“.' },
];

export const EFFECTS: { key: RuleEffect; label: string }[] = [
  { key: 'local', label: 'lokal' },
  { key: 'strong', label: 'stark' },
  { key: 'up', label: 'eine Stufe höher' },
  { key: 'down', label: 'eine Stufe tiefer' },
];

/** Bearbeitbare Regel: Kategorien als Text, leere Zahlenfelder = Bedingung entfällt. */
export interface RuleForm {
  categories: string;
  minHours: number | null;
  maxHours: number | null;
  minRetries: number | null;
  minBudgetPercent: number | null;
  tier: RuleEffect;
}

export function toForm(rule: RoutingRule): RuleForm {
  const { categories, minHours, maxHours, minRetries, minBudgetPercent } = rule.condition;
  return {
    categories: (categories ?? []).join(', '),
    minHours: minHours ?? null,
    maxHours: maxHours ?? null,
    minRetries: minRetries ?? null,
    minBudgetPercent: minBudgetPercent ?? null,
    tier: rule.tier,
  };
}

const present = (value: number | null | undefined | string): value is number =>
  value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));

export function fromForm(form: RuleForm): RoutingRule {
  const categories = form.categories
    .split(/[,\s/]+/)
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  return {
    tier: form.tier,
    condition: {
      ...(categories.length ? { categories } : {}),
      ...(present(form.minHours) ? { minHours: Number(form.minHours) } : {}),
      ...(present(form.maxHours) ? { maxHours: Number(form.maxHours) } : {}),
      ...(present(form.minRetries) ? { minRetries: Number(form.minRetries) } : {}),
      ...(present(form.minBudgetPercent) ? { minBudgetPercent: Number(form.minBudgetPercent) } : {}),
    },
  };
}

/**
 * Einstellungen → Budget: Limits je Tag, Sprint und Auftrag (Tokens, Kosten), Anzeigewährung mit festem Kurs und
 * Modell-Routing (Regeln nach Priorität, Modell je Stufe).
 */
@Component({
  selector: 'app-budget-settings',
  standalone: true,
  imports: [FormsModule, BudgetMeterComponent],
  templateUrl: './budget-settings.component.html',
  host: { style: 'display: contents' },
})
export class BudgetSettingsComponent {
  private readonly api = inject(ApiService);
  protected readonly store = inject(ProjectStore);
  protected readonly busy = this.store.busy;
  protected readonly periods = PERIODS;
  protected readonly effects = EFFECTS;
  protected readonly overview = signal<BudgetOverview | null>(null);
  protected limits: Record<BudgetPeriod, { maxTokens: number | null; maxCostUsd: number | null }> = {
    day: { maxTokens: null, maxCostUsd: null },
    sprint: { maxTokens: null, maxCostUsd: null },
    order: { maxTokens: null, maxCostUsd: null },
  };
  protected display = { currency: 'USD' as 'USD' | 'CHF', chfPerUsd: 0.8 };
  protected routing = { localModel: '', strongCommand: '', customized: false };
  protected rules: RuleForm[] = [];
  /** Projekt, dessen Werte im Formular stehen. */
  private loadedSlug = '';

  constructor() {
    effect(() => {
      this.store.foregroundLoads();
      const slug = this.store.activeProject();
      untracked(() => void this.load(slug));
    });
  }

  private async load(slug: string): Promise<void> {
    if (!slug) return;
    // Projektwechsel: Formular des alten Projekts ausblenden, damit „Speichern“ es nicht ins neue schreibt.
    if (this.loadedSlug !== slug) this.overview.set(null);
    try {
      const overview = await this.api.get<BudgetOverview>(`${this.api.projectPath(slug)}/budget`);
      if (!this.store.isActive(slug)) return;
      this.fill(overview);
      this.loadedSlug = slug;
    } catch {
      if (this.store.isActive(slug)) this.overview.set(null);
    }
  }

  private fill(overview: BudgetOverview): void {
    this.overview.set(overview);
    this.limits = {
      day: { ...overview.limits.day },
      sprint: { ...overview.limits.sprint },
      order: { ...overview.limits.order },
    };
    this.display = { currency: overview.currency, chfPerUsd: overview.chfPerUsd };
    this.routing = {
      localModel: overview.routing.localModel ?? '',
      strongCommand: (overview.routing.strongCommand ?? []).join(' '),
      customized: overview.routing.customized,
    };
    this.rules = overview.routing.rules.map(toForm);
  }

  protected addRule(): void {
    this.rules = [
      ...this.rules,
      { categories: '', minHours: null, maxHours: null, minRetries: null, minBudgetPercent: null, tier: 'local' },
    ];
    this.routing.customized = true;
  }

  protected removeRule(index: number): void {
    this.rules = this.rules.filter((_, position) => position !== index);
    this.routing.customized = true;
  }

  protected moveRule(index: number, offset: number): void {
    const target = index + offset;
    if (target < 0 || target >= this.rules.length) return;
    const rules = [...this.rules];
    [rules[index], rules[target]] = [rules[target]!, rules[index]!];
    this.rules = rules;
    this.routing.customized = true;
  }

  protected resetRules(): void {
    this.rules = (this.overview()?.routing.defaults ?? []).map(toForm);
    this.routing.customized = false;
  }

  protected async save(): Promise<void> {
    const slug = this.store.activeProject();
    if (slug !== this.loadedSlug) return;
    const number = (value: number | null) => (value === null || (value as unknown) === '' ? null : Number(value));
    await this.store.perform(
      async () => {
        const saved = await this.api.put<BudgetOverview>(`${this.api.projectPath(slug)}/budget`, {
          limits: Object.fromEntries(
            PERIODS.map(({ key }) => [
              key,
              { maxTokens: number(this.limits[key].maxTokens), maxCostUsd: number(this.limits[key].maxCostUsd) },
            ]),
          ),
          currency: this.display.currency,
          chfPerUsd: Number(this.display.chfPerUsd),
          // Unverändert die Standardregeln: nicht als eigene Regeln speichern (so gelten spätere Standards weiter).
          rules: this.routing.customized ? this.rules.map(fromForm) : null,
          localModel: this.routing.localModel.trim() || null,
          strongCommand: this.routing.strongCommand.trim() ? this.routing.strongCommand.trim().split(/\s+/) : null,
        });
        if (this.store.isActive(slug)) this.fill(saved);
      },
      'Budget gespeichert.',
      false,
    );
  }
}
