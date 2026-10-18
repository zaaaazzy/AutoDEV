import { NgClass } from '@angular/common';
import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../core/api.service.js';
import type { DevelopmentItem, Idea, Priority } from '../../core/models.js';
import { ProjectStore } from '../../core/project-store.js';
import { CATEGORIES, DEVELOPMENT_STATUSES, isFinished, statusLabel } from '../../shared/labels.js';
import { CategoryLabelPipe, StatusClassPipe, StatusLabelPipe } from '../../shared/pipes.js';
import { MarkdownPipe } from '../../shared/markdown.pipe.js';
import { OrderDetailComponent } from './order-detail.component.js';
import { OrderTableComponent } from './order-table.component.js';
import { orderProblem } from '../../shared/order-problem.js';
import { BugIconComponent } from '../../shared/bug-icon.component.js';
import { OrderService } from './order.service.js';

@Component({
  selector: 'app-development',
  standalone: true,
  imports: [
    OrderTableComponent,
    BugIconComponent,
    MarkdownPipe,
    NgClass,
    FormsModule,
    OrderDetailComponent,
    StatusClassPipe,
    StatusLabelPipe,
    CategoryLabelPipe,
  ],
  templateUrl: './development.component.html',
  host: { style: 'display: contents' },
})
export class DevelopmentComponent {
  private readonly api = inject(ApiService);
  private readonly orders = inject(OrderService);
  protected readonly store = inject(ProjectStore);
  protected readonly data = this.store.data;
  protected readonly busy = this.store.busy;
  protected readonly developmentStatuses = DEVELOPMENT_STATUSES;

  /** Laufzeit eines Entwurfs, z. B. „2 min“. */
  protected elapsed(startedAt: string): string {
    const seconds = Math.max(0, Math.round((Date.now() - new Date(startedAt).getTime()) / 1000));
    return seconds < 60 ? `${seconds} s` : `${Math.round(seconds / 60)} min`;
  }

  protected developmentForm: { title: string; priority: Priority; category: string } = {
    title: '',
    priority: 'medium',
    category: '',
  };
  protected readonly categories = CATEGORIES;
  /** Über einen Dashboard-Link auf „Erledigt“ gefiltert: erledigte Aufträge gleich aufklappen. */
  protected readonly showDoneOrders = signal(
    (this.store.filtersFor('development')['status'] ?? []).includes(statusLabel('done')),
  );

  /** Aufträge, die eine Entscheidung brauchen: fehlgeschlagen, aus dem Sprint genommen oder mit Punkten zum Prüfen. */
  protected readonly attention = computed(() => {
    const manual = new Map<string, number>();
    for (const check of this.data().acceptance) {
      if (check.status === 'manual') manual.set(check.developmentId, (manual.get(check.developmentId) ?? 0) + 1);
    }
    return this.data()
      .development.map((item) => {
        const reasons: { label: string; tone: 'error' | 'warn' | 'info' }[] = [];
        // Wartet der Auftrag auf einen Menschen, ist er nicht gescheitert, sondern braucht eine Aktion.
        if (item.status === 'rejected')
          reasons.push({ label: 'Abgelehnt – verstösst gegen Projektregel', tone: 'error' });
        else if (item.status === 'blocked' || (item.actionTodo && !isFinished(item.status)))
          reasons.push({ label: 'Aktion notwendig', tone: 'warn' });
        if (item.removedFromSprintAt && !isFinished(item.status)) {
          reasons.push({ label: `Aus Sprint „${item.removedFromSprint ?? '?'}“ genommen`, tone: 'info' });
        }
        const open = manual.get(item.id) ?? 0;
        if (open && !item.actionTodo) {
          reasons.push({ label: `${open} Punkt${open === 1 ? '' : 'e'} von dir zu prüfen`, tone: 'warn' });
        }
        return { item, reasons, manual: open };
      })
      .filter((entry) => entry.reasons.length);
  });
  private readonly attentionIds = computed(() => new Set(this.attention().map((entry) => entry.item.id)));
  protected readonly openAttention = signal<string | null>(null);

  constructor() {
    // Aus einem Link (#development/<id>, z. B. im Sprintbericht): Auftrag aufklappen und hinscrollen.
    effect(() => {
      const id = this.store.focusId();
      const inAttention = id ? this.attentionIds().has(id) : false;
      if (!id || !this.data().development.some((item) => item.id === id)) return;
      untracked(() => {
        if (inAttention) this.openAttention.set(id);
        else if (this.data().development.find((item) => item.id === id)?.status === 'done')
          this.showDoneOrders.set(true);
        globalThis.setTimeout(() => {
          const target = document.getElementById(`order-${id}`) ?? document.querySelector('.row-open');
          target?.scrollIntoView({ block: 'start', behavior: 'smooth' });
        }, 200);
      });
    });
  }
  protected readonly doneOrders = computed(() =>
    this.data().development.filter((item) => item.status === 'done' && !this.attentionIds().has(item.id)),
  );
  protected readonly openOrders = computed(() =>
    this.data().development.filter((item) => !isFinished(item.status) && !this.attentionIds().has(item.id)),
  );

  /** Problem und Lösung in wenigen Worten (dieselbe Kurzfassung wie im Sprint-Hover der Kopfzeile). */
  protected readonly problem = orderProblem;

  /** Sprintbericht mit dem ToDo-Kapitel des Auftrags (falls der Sprint schon dokumentiert ist). */
  protected sprintDoc(item: DevelopmentItem): string | null {
    const sprintId = item.sprintId;
    return sprintId
      ? (this.data().docs.find((doc) => doc.kind === 'sprint' && doc.sprintId === sprintId)?.id ?? null)
      : null;
  }

  protected openDoc(id: string): void {
    this.store.navigate('docs', { focus: id });
  }

  /** Kurzfassung des Fehlers: bevorzugt die nicht bestandenen Abnahmepunkte, sonst ein sauber beginnender Auszug. */
  protected failureSummary(failure: string): string {
    const acceptance = /## Abnahme nicht bestanden\n([\s\S]*?)(?:\n## |$)/.exec(failure)?.[1]?.trim();
    if (acceptance) return `**Abnahme nicht bestanden**\n${acceptance}`;
    const [head, ...rest] = failure.split('\n\n');
    let body = rest.join('\n\n').trim();
    if (/^[a-zäöüß`]/.test(body)) body = `…${body.replace(/^\S*\s*/, ' ')}`;
    return [head, body].filter(Boolean).join('\n\n');
  }

  protected retryOrder(item: DevelopmentItem): Promise<void> {
    return this.orders.retry(item);
  }

  protected analyzeOrder(item: DevelopmentItem): Promise<void> {
    return this.orders.analyze(item);
  }

  protected deleteOrder(item: DevelopmentItem): Promise<void> {
    return this.orders.remove(item);
  }

  protected confirmOrder(item: DevelopmentItem): Promise<void> {
    return this.orders.confirmChecks(item);
  }

  protected ideaOf(item: DevelopmentItem): Idea | null {
    return item.ideationId ? (this.data().ideas.find((idea) => idea.id === item.ideationId) ?? null) : null;
  }

  protected updateDevelopment(id: string, values: Partial<DevelopmentItem>): Promise<void> {
    return this.orders.update(id, values);
  }

  protected async createDevelopment(): Promise<void> {
    await this.store.perform(async () => {
      await this.api.post(`${this.api.projectPath(this.store.activeProject())}/development`, {
        ...this.developmentForm,
        category: this.developmentForm.category || null,
      });
      this.developmentForm = { title: '', priority: 'medium', category: '' };
      this.store.showCreate.set(false);
    }, 'Entwicklungsauftrag hinzugefügt.');
  }
}
