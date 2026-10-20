import { Component, computed, DestroyRef, effect, inject, signal } from '@angular/core';
import { ApiService } from '../../core/api.service.js';
import { AuthService } from '../../core/auth.service.js';
import { ProjectStore } from '../../core/project-store.js';
import { ConfirmService } from '../../core/confirm.service.js';
import { formatHours, formatUsd, USD_PER_MILLION_TOKENS } from '../../shared/format.js';
import { LocaleNumberPipe } from '../../shared/pipes.js';
import { proposalSelection } from './proposal-selection.js';

interface ProposalItem {
  id: string;
  title: string;
  score: number;
  reason: string;
  hours: number;
  tokens: number | null;
  selected: boolean;
  rank: number | null;
  carryOver: boolean;
}

interface Capacity {
  hours: number;
  tokens: number | null;
  source: 'history' | 'setting';
}

interface Totals {
  hours: number;
  tokens: number;
  costUsd: number | null;
}

interface Proposal {
  mode: 'manual' | 'suggest' | 'autopilot';
  name: string;
  capacity: Capacity;
  items: ProposalItem[];
  tokenPriceUsd: number | null;
  autopilot: {
    state: 'off' | 'paused' | 'finishing' | 'outside_hours' | 'ready';
    message: string | null;
  };
}

interface ProposalComment {
  itemIds: string[];
  status: 'requested' | 'running' | 'done' | 'failed';
  comment: string | null;
}

interface Roadmap {
  capacity: Capacity;
  sprints: { name: string; items: ProposalItem[]; totals: Totals }[];
}

/**
 * Sprintplanung: AIdeation schlägt aus dem Backlog den nächsten Sprint vor (Bewertung, Begründung, Summen mit Kosten).
 * Aufträge lassen sich ab- und zuwählen; „Übernehmen“ legt den Sprint mit dieser Reihenfolge an. Dazu: KI-Kommentar
 * des Auftragsautors (nur Text), Autopilot-Zustand mit Freigabe und eine Roadmap der nächsten 3 Sprints.
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
  private readonly confirm = inject(ConfirmService);
  protected readonly formatHours = formatHours;
  protected readonly formatUsd = formatUsd;

  protected readonly proposal = signal<Proposal | null>(null);
  protected readonly picked = signal<ReadonlySet<string>>(new Set());
  /** Im Modus „manuell“ erst auf Wunsch anzeigen. */
  protected readonly opened = signal(false);
  protected readonly mode = computed(() => this.store.currentProject()?.sprintMode ?? 'manual');
  protected readonly visible = computed(() => this.mode() !== 'manual' || this.opened());
  protected readonly hasActive = computed(() => this.store.data().sprints.some((sprint) => sprint.status === 'active'));

  protected readonly comment = signal<ProposalComment | null>(null);
  protected readonly roadmap = signal<Roadmap | null>(null);
  protected readonly roadmapOpen = signal(false);
  /** Platzsparend: standardmässig nur Kopfzeile mit Summen; aufgeklappt Tabelle und Aktionen (je Gerät gemerkt). */
  protected readonly expanded = signal(this.readExpanded());
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  /** Projekt, zu dem `proposal` gehört (Auswahl nur bei Projektwechsel zurücksetzen). */
  private loadedSlug = '';
  /**
   * Auslöser zum Neuladen: nur Aufträge und Sprints. Der Live-Refresh der Agent-Läufe ersetzt `data()` alle 3 s,
   * lässt diese Listen aber unverändert – dann soll der Vorschlag nicht neu laden.
   */
  private readonly development = computed(() => this.store.data().development);
  private readonly sprints = computed(() => this.store.data().sprints);

  /** Preis je Token: gemessen aus den Kosten der Agents, sonst Referenzpreis. */
  protected readonly price = computed(() => {
    const measured = this.proposal()?.tokenPriceUsd ?? null;
    return measured ?? USD_PER_MILLION_TOKENS / 1_000_000;
  });
  protected readonly priceSource = computed(() =>
    (this.proposal()?.tokenPriceUsd ?? null) !== null
      ? 'Kosten aus dem gemessenen Durchschnittspreis je Token (Verbrauch)'
      : `Noch keine gemessenen Kosten: Referenzpreis ${USD_PER_MILLION_TOKENS} $ je 1 Mio. Tokens`,
  );

  protected readonly chosen = computed(() => {
    const picked = this.picked();
    return (this.proposal()?.items ?? []).filter((item) => picked.has(item.id));
  });
  protected readonly totals = computed(() => {
    const tokens = this.chosen().reduce((sum, item) => sum + (item.tokens ?? 0), 0);
    return {
      hours: Math.round(this.chosen().reduce((sum, item) => sum + item.hours, 0) * 10) / 10,
      tokens,
      costUsd: Math.round(tokens * this.price() * 100) / 100,
    };
  });
  /** Der Kommentar gilt nur für die Auswahl, zu der er geschrieben wurde. */
  protected readonly commentMatches = computed(() => {
    const comment = this.comment();
    const chosen = this.chosen().map((item) => item.id);
    return !!comment && comment.itemIds.length === chosen.length && comment.itemIds.every((id, i) => id === chosen[i]);
  });
  protected readonly commentPending = computed(() => ['requested', 'running'].includes(this.comment()?.status ?? ''));

  constructor() {
    // Neu laden, wenn sich Projekt oder Aufträge ändern (z. B. nach dem Übernehmen).
    effect(() => {
      const slug = this.store.activeProject();
      this.development();
      this.sprints();
      if (slug && this.visible()) void this.load(slug);
    });
    inject(DestroyRef).onDestroy(() => this.stopPolling());
  }

  private async load(slug: string): Promise<void> {
    const base = `${this.api.projectPath(slug)}/sprints`;
    const [result, comment] = await Promise.all([
      this.api.get<{ proposal: Proposal }>(`${base}/proposal`).catch(() => null),
      this.api.get<{ comment: ProposalComment | null }>(`${base}/proposal/comment`).catch(() => null),
    ]);
    if (!result || slug !== this.store.activeProject()) return;
    const previous = this.proposal();
    this.picked.set(
      proposalSelection(
        previous && { slug: this.loadedSlug, ids: previous.items.map((item) => item.id), picked: this.picked() },
        slug,
        result.proposal.items,
      ),
    );
    this.proposal.set(result.proposal);
    this.loadedSlug = slug;
    this.comment.set(comment?.comment ?? null);
    if (this.commentPending()) this.pollComment(slug);
    if (this.roadmapOpen()) void this.loadRoadmap(slug);
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
    const chosen = this.chosen();
    if (!proposal || !chosen.length) return;
    const answer = await this.confirm.ask({
      title: start ? `${proposal.name} übernehmen und starten?` : `${proposal.name} übernehmen?`,
      message: start
        ? `Der Sprint wird mit ${chosen.length} Aufträgen angelegt und gleich gestartet; der Worker beginnt mit der Umsetzung.`
        : `Der Sprint wird mit ${chosen.length} Aufträgen angelegt (noch nicht gestartet).`,
      details: chosen.map((item) => item.title),
      confirmLabel: start ? 'Übernehmen und starten' : 'Übernehmen',
      commentLabel: 'Sprintziel / Kommentar (optional)',
      commentPlaceholder: 'z. B. „Fokus: Login stabilisieren, keine neuen Features.“',
      commentHint: 'Wird als Sprintziel gespeichert.',
    });
    if (!answer) return;
    await this.store.perform(
      () =>
        this.api.post(`${this.api.projectPath(this.store.activeProject())}/sprints/proposal/apply`, {
          ids: chosen.map((item) => item.id),
          start,
          comment: answer.comment,
        }),
      start ? `${proposal.name} ist angelegt und gestartet.` : `${proposal.name} ist angelegt.`,
    );
    this.comment.set(null);
    this.opened.set(false);
  }

  /** Auftragsautor kommentiert die aktuelle Auswahl (der Worker schreibt ihn, die Oberfläche fragt nach). */
  protected async requestComment(): Promise<void> {
    const slug = this.store.activeProject();
    const ids = this.chosen().map((item) => item.id);
    if (!ids.length) return;
    await this.store.perform(
      async () => {
        const result = await this.api.post<{ comment: ProposalComment }>(
          `${this.api.projectPath(slug)}/sprints/proposal/comment`,
          { ids },
        );
        this.comment.set(result.comment);
        this.pollComment(slug);
      },
      'Der Auftragsautor kommentiert den Vorschlag …',
      false,
    );
  }

  private pollComment(slug: string): void {
    this.stopPolling();
    this.pollTimer = setTimeout(async () => {
      const result = await this.api
        .get<{ comment: ProposalComment | null }>(`${this.api.projectPath(slug)}/sprints/proposal/comment`)
        .catch(() => null);
      if (slug !== this.store.activeProject()) return;
      this.comment.set(result?.comment ?? null);
      if (this.commentPending()) this.pollComment(slug);
    }, 2000);
  }

  private stopPolling(): void {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }

  protected async resumeAutopilot(): Promise<void> {
    const slug = this.store.activeProject();
    await this.store.perform(
      () => this.api.post(`${this.api.projectPath(slug)}/sprints/autopilot/resume`, {}),
      'Autopilot freigegeben – er plant beim nächsten Durchgang weiter.',
      false,
    );
    await this.load(slug);
  }

  protected toggleExpanded(): void {
    const open = !this.expanded();
    this.expanded.set(open);
    try {
      globalThis.localStorage?.setItem('devlog.proposal.open', open ? '1' : '0');
    } catch {
      /* ohne Speicher bleibt es beim Standard */
    }
  }

  private readExpanded(): boolean {
    try {
      return globalThis.localStorage?.getItem('devlog.proposal.open') === '1';
    } catch {
      return false;
    }
  }

  protected async toggleRoadmap(): Promise<void> {
    if (!this.expanded()) this.toggleExpanded();
    this.roadmapOpen.update((open) => !open);
    if (this.roadmapOpen()) await this.loadRoadmap(this.store.activeProject());
  }

  private async loadRoadmap(slug: string): Promise<void> {
    const result = await this.api
      .get<{ roadmap: Roadmap }>(`${this.api.projectPath(slug)}/sprints/roadmap`)
      .catch(() => null);
    if (result && slug === this.store.activeProject()) this.roadmap.set(result.roadmap);
  }

  protected costOf(totals: Totals): number {
    return totals.costUsd ?? Math.round(totals.tokens * this.price() * 100) / 100;
  }
}
