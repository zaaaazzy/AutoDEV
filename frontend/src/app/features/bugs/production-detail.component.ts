import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { ApiService } from '../../core/api.service.js';
import { AuthService } from '../../core/auth.service.js';
import { ConfirmService } from '../../core/confirm.service.js';
import type { ProductionEvent, RollbackEntry, RollbackProposal } from '../../core/models.js';
import { ProjectStore } from '../../core/project-store.js';
import { visibleInterval } from '../../core/visible-interval.js';
import { DateTimePipe } from '../../shared/pipes.js';

const SOURCE_LABEL: Record<ProductionEvent['source'], string> = {
  health: 'Health-Check',
  logs: 'Compose-Logs',
  ingest: 'Ingest',
};

const ROLLBACK_STATUS: Record<RollbackEntry['status'], string> = {
  requested: 'Wartet auf den Worker',
  running: 'Läuft …',
  succeeded: 'Erfolgreich',
  failed: 'Fehlgeschlagen',
};

/** Protokoll neu laden, solange ein Rollback angefordert ist oder läuft. */
const ROLLBACK_POLL_MS = 5000;

/**
 * Bug-Detail für Betriebs-Bugs: Vorkommen je Stunde (48 h), gebündelte Ereignisse mit maskiertem Beispiel und der
 * Deploy-Verdacht. Beispiele erscheinen als reiner Text, nie als HTML. Bei kritischem Bug mit Deploy-Verdacht der
 * Rollback-Vorschlag: Knopf, Bestätigung mit Zieltag und das Rollback-Protokoll.
 */
@Component({
  selector: 'app-production-detail',
  standalone: true,
  imports: [DateTimePipe],
  templateUrl: './production-detail.component.html',
  host: { style: 'display: contents' },
})
export class ProductionDetailComponent {
  private readonly api = inject(ApiService);
  private readonly confirm = inject(ConfirmService);
  protected readonly auth = inject(AuthService);
  protected readonly store = inject(ProjectStore);
  readonly bugId = input.required<string>();
  protected readonly events = signal<ProductionEvent[]>([]);
  protected readonly history = signal<{ hour: string; count: number }[]>([]);
  protected readonly error = signal<string | null>(null);
  protected readonly proposal = signal<RollbackProposal | null>(null);
  protected readonly rollbacks = signal<RollbackEntry[]>([]);
  protected readonly rollbackMessage = signal<string | null>(null);
  protected readonly sending = signal(false);
  protected readonly sourceLabel = SOURCE_LABEL;
  protected readonly rollbackStatus = ROLLBACK_STATUS;
  protected readonly peak = computed(() => Math.max(1, ...this.history().map((entry) => entry.count)));
  protected readonly total = computed(() => this.history().reduce((sum, entry) => sum + entry.count, 0));
  /** Rollback auslösen braucht dieselbe Rolle wie „Live schalten“ (Planung). */
  protected readonly mayRollback = computed(() => this.auth.can('plan'));
  /** Grund für den deaktivierten Knopf: zuerst der Server (zentral), dann die fehlende Berechtigung. */
  protected readonly blockedReason = computed(() => {
    const proposal = this.proposal();
    if (!proposal) return null;
    if (proposal.disabledReason) return proposal.disabledReason;
    if (this.sending()) return 'Rollback wird angefordert …';
    return this.mayRollback() ? null : 'Dafür fehlt die Berechtigung „Planung“.';
  });
  private readonly active = computed(() =>
    this.rollbacks().some((entry) => entry.status === 'requested' || entry.status === 'running'),
  );

  constructor() {
    effect(() => {
      const id = this.bugId();
      this.store.foregroundLoads();
      void this.load(id);
      void this.loadRollback(id);
    });
    effect((onCleanup) => {
      if (!this.active()) return;
      const id = this.bugId();
      onCleanup(visibleInterval(() => void this.loadRollback(id), ROLLBACK_POLL_MS));
    });
  }

  private async load(id: string): Promise<void> {
    try {
      const result = await this.api.get<{ events: ProductionEvent[]; history: { hour: string; count: number }[] }>(
        `/api/bugs/${encodeURIComponent(id)}/production`,
      );
      this.events.set(result.events ?? []);
      this.history.set(result.history ?? []);
      this.error.set(null);
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : 'Verlauf konnte nicht geladen werden.');
    }
  }

  private async loadRollback(id: string): Promise<void> {
    try {
      const result = await this.api.get<{ proposal: RollbackProposal | null; rollbacks: RollbackEntry[] }>(
        `/api/bugs/${encodeURIComponent(id)}/rollback`,
      );
      if (id !== this.bugId()) return;
      this.proposal.set(result.proposal ?? null);
      this.rollbacks.set(result.rollbacks ?? []);
    } catch {
      // Ohne Vorschlag kein Knopf; Verlauf und Ereignisse bleiben sichtbar.
      this.proposal.set(null);
    }
  }

  /** Erst nach Bestätigung im Dialog (mit Zieltag) geht die Anforderung an den Server. */
  protected async startRollback(): Promise<void> {
    const proposal = this.proposal();
    if (!proposal?.toTag || this.blockedReason()) return;
    const migrations = proposal.migrations;
    const answer = await this.confirm.ask({
      title: 'Vorherigen Sprint-Tag wieder ausrollen',
      message: `${proposal.toTag} wird über den normalen Deploy-Pfad ausgerollt (statt ${proposal.fromTag}). Der Bug bleibt offen.`,
      details: [
        `Zieltag: ${proposal.toTag}`,
        `Aktuell ausgerollt: ${proposal.fromTag}`,
        ...(migrations === null
          ? ['Migrationen konnten nicht geprüft werden – Datenbankstand vor dem Rollback prüfen.']
          : migrations.length
            ? [
                `Achtung: Der Zieltag kennt ${migrations.length} neuere Migration(en) nicht – die Datenbank wird nicht zurückgesetzt:`,
                ...migrations,
              ]
            : []),
      ],
      confirmLabel: `${proposal.toTag} ausrollen`,
      withoutComment: true,
      danger: true,
    });
    if (!answer) return;
    const id = this.bugId();
    this.sending.set(true);
    this.rollbackMessage.set(null);
    try {
      await this.api.post(`/api/bugs/${encodeURIComponent(id)}/rollback`, { toTag: proposal.toTag });
      this.rollbackMessage.set(`Rollback auf ${proposal.toTag} angefordert – der Worker rollt ihn aus.`);
    } catch (error) {
      this.rollbackMessage.set(error instanceof Error ? error.message : 'Rollback konnte nicht angefordert werden.');
    } finally {
      this.sending.set(false);
      await this.loadRollback(id);
    }
  }

  protected hourLabel(hour: string): string {
    return new Date(hour).toLocaleString('de-CH', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  }

  protected barHeight(count: number): number {
    return count ? Math.max(4, (count / this.peak()) * 100) : 0;
  }
}
