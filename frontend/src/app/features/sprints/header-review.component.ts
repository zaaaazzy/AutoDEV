import { Component, ElementRef, computed, effect, inject, signal, untracked } from '@angular/core';
import { ApiService } from '../../core/api.service.js';
import { AuthService } from '../../core/auth.service.js';
import type { ReviewCommit, ReviewSlot } from '../../core/models.js';
import { ProjectStore } from '../../core/project-store.js';
import { ReviewLaunchService } from '../../core/review-launch.service.js';
import { formatIsoDate } from '../../shared/format.js';
import { groupReviewCommits, headerReviewSlot, reviewCommitBadge, shortUrl } from './header-review.js';
import { reviewStarting, reviewStatusText } from './review-launch.js';

/** Abfrage der Stände und Container; schneller, solange ein Container startet. */
const REFRESH_MS = 15_000;
const STARTING_REFRESH_MS = 3_000;

/**
 * Kopfzeile rechts neben der Projektwahl: einen Stand (Commit mit Auftragsname) wählen, mit ▶ im Review-Container
 * starten, den Link öffnen und den Container mit ■ wieder beenden.
 */
@Component({
  selector: 'app-header-review',
  standalone: true,
  templateUrl: './header-review.component.html',
  host: {
    class: 'header-review',
    '(document:click)': 'closeOnOutside($event)',
    '(document:keydown.escape)': 'closeMenu()',
  },
})
export class HeaderReviewComponent {
  private readonly api = inject(ApiService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly store = inject(ProjectStore);
  protected readonly auth = inject(AuthService);
  protected readonly launch = inject(ReviewLaunchService);

  protected readonly commits = signal<ReviewCommit[]>([]);
  protected readonly chosenHash = signal('');
  protected readonly open = signal(false);
  protected readonly loadError = signal(false);
  /** Erste Antwort für das aktuelle Projekt ist da (vorher „wird geladen“ statt „keine Stände“). */
  protected readonly loaded = signal(false);

  protected readonly groups = computed(() => groupReviewCommits(this.commits()));
  protected readonly chosen = computed(
    () => this.commits().find((commit) => commit.hash === this.chosenHash()) ?? this.commits()[0] ?? null,
  );
  protected readonly slot = computed(() =>
    headerReviewSlot(this.launch.slots(), this.store.activeProject(), this.launch.pending()),
  );
  protected readonly starting = computed(() => this.launch.busy() || reviewStarting(this.slot()));
  /** Commit, den der Container zeigt – für die Markierung in der Liste. */
  protected readonly runningHash = computed(() => this.slot()?.commit ?? null);

  constructor() {
    effect((onCleanup) => {
      const project = this.store.activeProject();
      let timer: ReturnType<typeof setTimeout> | null = null;
      let stopped = false;
      const tick = async (): Promise<void> => {
        if (!document.hidden) await this.load(project);
        if (stopped) return;
        timer = setTimeout(() => void tick(), untracked(() => this.starting()) ? STARTING_REFRESH_MS : REFRESH_MS);
      };
      untracked(() => {
        this.commits.set([]);
        this.chosenHash.set('');
        this.loaded.set(false);
      });
      void tick();
      onCleanup(() => {
        stopped = true;
        if (timer) clearTimeout(timer);
      });
    });
  }

  private async load(project: string): Promise<void> {
    void this.launch.loadSlots().catch(() => undefined);
    try {
      const result = await this.api.get<{ commits: ReviewCommit[] }>(
        `/api/projects/${encodeURIComponent(project)}/review-commits`,
      );
      // Antwort für ein inzwischen gewechseltes Projekt verwerfen.
      if (project !== this.store.activeProject()) return;
      this.commits.set(result.commits);
      this.loadError.set(false);
      this.loaded.set(true);
      if (!result.commits.some((commit) => commit.hash === this.chosenHash())) {
        this.chosenHash.set(result.commits[0]?.hash ?? '');
      }
    } catch {
      // Alten Stand behalten, nächster Versuch beim nächsten Intervall.
      if (project === this.store.activeProject()) this.loadError.set(true);
    }
  }

  protected toggle(): void {
    if (!this.commits().length) return;
    this.open.update((open) => !open);
    if (this.open()) {
      // Fokus auf den gewählten Eintrag, damit die Pfeiltasten gleich wirken.
      setTimeout(() =>
        this.host.nativeElement.querySelector<HTMLElement>('.review-option[aria-selected="true"]')?.focus(),
      );
    }
  }

  protected choose(commit: ReviewCommit): void {
    this.chosenHash.set(commit.hash);
    this.closeMenu();
    this.host.nativeElement.querySelector<HTMLElement>('.review-trigger')?.focus();
  }

  protected closeMenu(): void {
    this.open.set(false);
  }

  protected closeOnOutside(event: Event): void {
    if (this.open() && !this.host.nativeElement.contains(event.target as Node)) this.open.set(false);
  }

  /** Pfeiltasten wandern durch die Liste. */
  protected move(event: KeyboardEvent): void {
    const items = Array.from(this.host.nativeElement.querySelectorAll<HTMLElement>('.review-option'));
    const index = items.indexOf(document.activeElement as HTMLElement);
    const next =
      event.key === 'ArrowDown' ? index + 1 : event.key === 'ArrowUp' ? index - 1 : event.key === 'Home' ? 0 : null;
    if (next === null) return;
    event.preventDefault();
    items[(next + items.length) % items.length]?.focus();
  }

  protected start(): void {
    const commit = this.chosen();
    if (!commit || this.starting() || !this.auth.can('run')) return;
    void this.launch.start(this.store.activeProject(), { ...commit, subject: commit.title }, false);
  }

  protected stop(slot: ReviewSlot): void {
    void this.launch.stop(slot);
  }

  protected badge(commit: ReviewCommit): ReturnType<typeof reviewCommitBadge> {
    return reviewCommitBadge(commit);
  }

  protected date(commit: ReviewCommit): string {
    return formatIsoDate(commit.date);
  }

  protected statusText(slot: ReviewSlot): string {
    return reviewStatusText(slot);
  }

  protected linkText(slot: ReviewSlot): string {
    return shortUrl(slot.url);
  }

  /** Titel des Stands, den der Container gerade zeigt (aus der Liste, sonst aus der Beschriftung des Containers). */
  protected slotTitle(slot: ReviewSlot): string {
    return this.commits().find((commit) => commit.hash === slot.commit)?.title ?? slot.label ?? 'Review';
  }
}
