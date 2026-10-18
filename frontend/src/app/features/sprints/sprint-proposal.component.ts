import { Component, computed, effect, inject, signal } from '@angular/core';
import { ApiService } from '../../core/api.service.js';
import { AuthService } from '../../core/auth.service.js';
import { ProjectStore } from '../../core/project-store.js';
import { formatHours } from '../../shared/format.js';
import { LocaleNumberPipe } from '../../shared/pipes.js';

interface ProposalItem {
  id: string;
  title: string;
  score: number;
  reason: string;
  hours: number;
  tokens: number | null;
  selected: boolean;
  rank: number | null;
}

interface Proposal {
  mode: 'manual' | 'suggest' | 'autopilot';
  name: string;
  capacity: { hours: number; tokens: number | null; source: 'history' | 'setting' };
  items: ProposalItem[];
}

/**
 * Sprintplanung: Dev Log schlägt aus dem Backlog den nächsten Sprint vor (Bewertung, Begründung, Summen).
 * Aufträge lassen sich ab- und zuwählen; „Übernehmen“ legt den Sprint mit dieser Reihenfolge an.
 */
@Component({
  selector: 'app-sprint-proposal',
  standalone: true,
  imports: [LocaleNumberPipe],
  templateUrl: './sprint-proposal.component.html',
})
export class SprintProposalComponent {
  private readonly api = inject(ApiService);
  protected readonly store = inject(ProjectStore);
  protected readonly auth = inject(AuthService);
  protected readonly formatHours = formatHours;

  protected readonly proposal = signal<Proposal | null>(null);
  protected readonly picked = signal<ReadonlySet<string>>(new Set());
  /** Im Modus „manuell“ erst auf Wunsch anzeigen. */
  protected readonly opened = signal(false);
  protected readonly mode = computed(() => this.store.currentProject()?.sprintMode ?? 'manual');
  protected readonly visible = computed(() => this.mode() !== 'manual' || this.opened());
  protected readonly hasActive = computed(() => this.store.data().sprints.some((sprint) => sprint.status === 'active'));

  protected readonly chosen = computed(() => {
    const picked = this.picked();
    return (this.proposal()?.items ?? []).filter((item) => picked.has(item.id));
  });
  protected readonly totals = computed(() => ({
    hours: Math.round(this.chosen().reduce((sum, item) => sum + item.hours, 0) * 10) / 10,
    tokens: this.chosen().reduce((sum, item) => sum + (item.tokens ?? 0), 0),
  }));

  constructor() {
    // Neu laden, wenn sich Projekt oder Aufträge ändern (z. B. nach dem Übernehmen).
    effect(() => {
      const slug = this.store.activeProject();
      const data = this.store.data();
      if (slug && this.visible() && data) void this.load(slug);
    });
  }

  private async load(slug: string): Promise<void> {
    const result = await this.api
      .get<{ proposal: Proposal }>(`${this.api.projectPath(slug)}/sprints/proposal`)
      .catch(() => null);
    if (!result || slug !== this.store.activeProject()) return;
    this.proposal.set(result.proposal);
    this.picked.set(new Set(result.proposal.items.filter((item) => item.selected).map((item) => item.id)));
  }

  protected toggle(id: string): void {
    this.picked.update((set) => {
      const next = new Set(set);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  protected async apply(start: boolean): Promise<void> {
    const proposal = this.proposal();
    if (!proposal || !this.chosen().length) return;
    await this.store.perform(
      () =>
        this.api.post(`${this.api.projectPath(this.store.activeProject())}/sprints/proposal/apply`, {
          ids: this.chosen().map((item) => item.id),
          start,
        }),
      start ? `${proposal.name} ist angelegt und gestartet.` : `${proposal.name} ist angelegt.`,
    );
    this.opened.set(false);
  }
}
