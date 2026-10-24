import { Component, DestroyRef, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { ApiService } from '../../core/api.service.js';
import { AuthService } from '../../core/auth.service.js';
import type { DevelopmentItem, ReviewSlot, VisualApproval, VisualDevice, VisualSnapshot } from '../../core/models.js';
import { ProjectStore } from '../../core/project-store.js';
import { ChangedFilesComponent } from '../../shared/changed-files.component.js';
import { DateTimePipe } from '../../shared/pipes.js';
import { OrderService } from './order.service.js';
import {
  defaultSlot,
  showsOrder,
  type SlotTone,
  slotLoadedText,
  slotOptionText,
  slotStatusText,
  slotTone,
  spawnLabel,
  VISUAL_REVIEW_WHY,
} from './visual-review.js';

export interface VisualPage {
  page: string;
  after: VisualSnapshot;
  before: VisualSnapshot | null;
  diff: VisualSnapshot | null;
}

/**
 * Je Seite die neueste Aufnahme des Auftrags auf dem gewählten Gerät, dazu der Vorher-Stand (Basis des Vergleichs,
 * oft aus einem früheren Auftrag) und das Diff-Bild.
 */
export function visualPages(snapshots: VisualSnapshot[], orderId: string, device: VisualDevice): VisualPage[] {
  const own = snapshots.filter((shot) => shot.developmentId === orderId && shot.device === device);
  const latest = new Map<string, VisualSnapshot>();
  for (const shot of own.filter((entry) => entry.kind === 'shot')) {
    const known = latest.get(shot.page);
    if (!known || known.createdAt <= shot.createdAt) latest.set(shot.page, shot);
  }
  return [...latest.values()].map((after) => ({
    page: after.page,
    after,
    before: after.baseId ? (snapshots.find((shot) => shot.id === after.baseId) ?? null) : null,
    diff:
      own
        .filter((shot) => shot.kind === 'diff' && shot.page === after.page && shot.baseId === after.baseId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null,
  }));
}

/** Abfrage der Umgebungen, solange die Abnahme offen ist; schneller, solange eine startet. */
const SLOTS_REFRESH_MS = 15_000;
const SLOTS_STARTING_MS = 3_000;

/**
 * Optische Abnahme eines Auftrags: in einer der Umgebungen (Review-Container) starten und ansehen, geänderte Dateien
 * mit Link ins Repository, Vorher/Nachher/Diff je Seite und zuletzt „Optisch freigeben“.
 */
@Component({
  selector: 'app-order-visual',
  standalone: true,
  imports: [DateTimePipe, ChangedFilesComponent],
  templateUrl: './order-visual.component.html',
})
export class OrderVisualComponent {
  private readonly api = inject(ApiService);
  private readonly store = inject(ProjectStore);
  private readonly orders = inject(OrderService);
  protected readonly auth = inject(AuthService);

  readonly order = input.required<DevelopmentItem>();
  /** Gleich aufgeklappt (oben unter „Aktionen“), sonst erst beim Klick. */
  readonly open = input(false);
  protected readonly why = VISUAL_REVIEW_WHY;
  protected readonly snapshots = signal<VisualSnapshot[]>([]);
  protected readonly loaded = signal<VisualApproval | null>(null);
  protected readonly loading = signal(false);
  protected readonly error = signal('');
  protected readonly busy = this.store.busy;
  protected readonly device = signal<VisualDevice>('desktop');
  protected readonly pages = computed(() => visualPages(this.snapshots(), this.order().id, this.device()));
  /** Geladene Freigabe, sonst der Stand aus der Auftragsliste. */
  protected readonly approval = computed<VisualApproval>(
    () =>
      this.loaded() ?? {
        approvedAt: this.order().visualApprovedAt ?? null,
        approvedBy: this.order().visualApprovedBy ?? null,
      },
  );

  /** Umgebungen (Review-Container) mit Status und geladenem Stand. */
  protected readonly slots = signal<ReviewSlot[]>([]);
  protected readonly slotsLoaded = signal(false);
  private readonly picked = signal<number | null>(null);
  protected readonly chosen = computed(() => this.picked() ?? defaultSlot(this.slots(), this.order().id));
  protected readonly chosenSlot = computed(() => this.slots().find((slot) => slot.slot === this.chosen()) ?? null);
  /** Umgebung, die diesen Auftrag gerade zeigt (für Link und Git-Stand der Dateien). */
  protected readonly ownSlot = computed(() => this.slots().find((slot) => showsOrder(slot, this.order().id)) ?? null);
  protected readonly sprint = computed(() => this.store.sprintOf(this.order()));
  protected readonly fileRef = computed(() => this.ownSlot()?.commit ?? this.order().reviewBranch ?? null);
  protected readonly canSpawn = computed(
    () => this.auth.can('run') && this.order().status !== 'in_progress' && !!this.chosenSlot()?.enabled,
  );
  private stopTimer: ReturnType<typeof setTimeout> | null = null;
  private active = false;

  constructor() {
    inject(DestroyRef).onDestroy(() => this.stopSlots());
    // Gleich aufgeklappt (Aktionen): sofort laden, ohne auf das toggle-Ereignis zu warten.
    effect(() => {
      if (this.open()) untracked(() => this.activate());
    });
  }

  protected toggled(event: Event): void {
    if ((event.target as HTMLDetailsElement).open) this.activate();
    else this.stopSlots();
  }

  private activate(): void {
    if (!this.snapshots().length && !this.loading()) void this.load();
    if (!this.active) {
      this.active = true;
      void this.pollSlots();
    }
  }

  private path(): string {
    return `/api/development/${encodeURIComponent(this.order().id)}/visual`;
  }

  private async load(): Promise<void> {
    this.loading.set(true);
    this.error.set('');
    try {
      const result = await this.api.get<{ snapshots: VisualSnapshot[]; approval: VisualApproval }>(this.path());
      this.snapshots.set(result.snapshots);
      this.loaded.set(result.approval);
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.loading.set(false);
    }
  }

  /** Umgebungen laden und im Takt nachfragen; schneller, solange eine startet oder angefordert ist. */
  private async pollSlots(): Promise<void> {
    if (!this.active) return;
    if (!document.hidden) await this.loadSlots();
    if (!this.active) return;
    const starting = this.slots().some((slot) => slot.status === 'requested' || slot.status === 'starting');
    this.stopTimer = setTimeout(() => void this.pollSlots(), starting ? SLOTS_STARTING_MS : SLOTS_REFRESH_MS);
  }

  private async loadSlots(): Promise<void> {
    try {
      const result = await this.api.get<{ slots: ReviewSlot[] }>('/api/review-slots');
      this.slots.set(result.slots);
    } catch {
      // Alten Stand behalten, nächster Versuch im Takt.
    } finally {
      this.slotsLoaded.set(true);
    }
  }

  private stopSlots(): void {
    this.active = false;
    if (this.stopTimer) clearTimeout(this.stopTimer);
    this.stopTimer = null;
  }

  protected pick(value: string | number): void {
    this.picked.set(Number(value) || null);
  }

  /** Diesen Auftrag in der gewählten Umgebung laden; danach schneller nachfragen, bis sie läuft. */
  protected async spawn(): Promise<void> {
    const slot = this.chosen();
    if (!slot || !this.canSpawn()) return;
    if (await this.orders.showReview(this.order(), slot)) {
      this.picked.set(slot);
      this.stopSlots();
      this.active = true;
      void this.pollSlots();
    }
  }

  /** Umgebung beenden (wird wieder frei). */
  protected async stop(slot: ReviewSlot): Promise<void> {
    await this.api.post(`/api/review-slots/${slot.slot}/stop`).catch(() => undefined);
    await this.loadSlots();
  }

  protected tone(slot: ReviewSlot): SlotTone {
    return slotTone(slot);
  }
  protected statusText(slot: ReviewSlot): string {
    return slotStatusText(slot);
  }
  protected loadedText(slot: ReviewSlot): string {
    return slotLoadedText(slot);
  }
  protected optionText(slot: ReviewSlot): string {
    return slotOptionText(slot, this.order().id);
  }
  protected isOwn(slot: ReviewSlot): boolean {
    return showsOrder(slot, this.order().id);
  }
  protected spawnText(): string {
    return spawnLabel(this.chosenSlot(), this.order().id);
  }
  protected spawnHint(): string {
    if (!this.auth.can('run')) return 'Umgebungen starten braucht das Recht, Agents zu starten.';
    if (this.order().status === 'in_progress') return 'Der Auftrag läuft gerade – erst danach ladbar.';
    if (!this.chosenSlot()?.enabled)
      return 'Diese Umgebung ist gesperrt – ein Administrator gibt sie unter Einstellungen frei.';
    return 'Startet den Stand dieses Auftrags in der gewählten Umgebung. Ein dort geladener anderer Stand wird ersetzt.';
  }

  protected image(snapshot: VisualSnapshot): string {
    return this.api.url(`/api/visual-snapshots/${encodeURIComponent(snapshot.id)}`);
  }

  protected percent(value: number): string {
    return `${value.toLocaleString('de-CH', { maximumFractionDigits: 2 })} %`;
  }

  /** Speichert Person und Zeitpunkt der optischen Freigabe am Auftrag (oder nimmt sie zurück). */
  protected approve(approved: boolean): Promise<void> {
    return this.store.perform(
      async () => {
        const result = await this.api.post<{ approval: VisualApproval }>(`${this.path()}/approve`, { approved });
        this.loaded.set(result.approval);
      },
      approved ? 'Optisch freigegeben.' : 'Optische Freigabe zurückgenommen.',
    );
  }
}
