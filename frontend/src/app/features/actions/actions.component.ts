import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { ApiService } from '../../core/api.service.js';
import { AuthService } from '../../core/auth.service.js';
import type { AcceptanceCheck, DevelopmentItem, TestEvidence } from '../../core/models.js';
import { SettingsGroups } from '../settings/settings-group.js';
import { ProjectStore } from '../../core/project-store.js';
import type { AttentionCard, CardStep } from '../../shared/attention-card.js';
import type { AttentionEntry } from '../../shared/order-attention.js';
import { isFinished } from '../../shared/labels.js';
import { MarkdownPipe } from '../../shared/markdown.pipe.js';
import { OrderQuestionComponent } from '../../shared/order-question.component.js';
import { OrderApprovalComponent } from '../development/order-approval.component.js';
import { OrderDetailComponent } from '../development/order-detail.component.js';
import { OrderVisualComponent } from '../development/order-visual.component.js';
import { actionHint } from './action-hints.js';
import { needsVisual } from '../development/needs-visual.js';
import { OrderDetailSlotDirective, OrderTableComponent } from '../development/order-table.component.js';
import { OrderService } from '../development/order.service.js';
import { AcceptanceReviewComponent } from './acceptance-review.component.js';
import { RunningPanelComponent } from './running-panel.component.js';

const EVIDENCE_REASON_LABELS: Record<TestEvidence['grund'], string> = {
  nicht_freigegeben: 'Befehl für den Agent nicht freigegeben',
  gegenprobe_fehlt: 'Gegenprobe fehlt',
};

/**
 * Seite „Aktionen“: Rückmeldungen der Agents und alles, was auf dich wartet – Rückfragen, blockierte oder
 * abgelehnte Aufträge, Freigaben, aus dem Sprint genommene Aufträge, Punkte, die nur ein Mensch prüfen kann, und
 * offene Testnachweise.
 * Diese Aufträge stehen nicht mehr in der Liste unter „Aufträge“.
 */
@Component({
  selector: 'app-actions',
  standalone: true,
  imports: [
    RunningPanelComponent,
    OrderVisualComponent,
    AcceptanceReviewComponent,
    MarkdownPipe,
    OrderApprovalComponent,
    OrderDetailComponent,
    OrderDetailSlotDirective,
    OrderQuestionComponent,
    OrderTableComponent,
  ],
  templateUrl: './actions.component.html',
  host: { style: 'display: contents' },
})
export class ActionsComponent {
  private readonly orders = inject(OrderService);
  private readonly api = inject(ApiService);
  private readonly settingsGroups = inject(SettingsGroups);
  protected readonly store = inject(ProjectStore);
  protected readonly auth = inject(AuthService);
  protected readonly data = this.store.data;
  protected readonly busy = this.store.busy;
  protected readonly isFinished = isFinished;
  protected readonly attention = this.store.attention;
  /** Zeilen der Tabelle – dieselbe Darstellung wie unter „Aufträge“. */
  protected readonly items = computed(() => this.attention().map((entry) => entry.item));
  private readonly entries = computed(() => new Map(this.attention().map((entry) => [entry.item.id, entry])));
  /** Aufträge mit eingeblendeten Auftragsdetails (Knopf „Details“); zu ist der Normalfall. */
  private readonly detailsShown = signal<ReadonlySet<string>>(new Set());
  /** Antwort bzw. Hinweis an die Agents je Auftrag, bis „Erneut versuchen“ ihn mitschickt. */
  private readonly notes = signal<Record<string, string>>({});

  constructor() {
    // Aus einem Link (#actions/<id> oder umgeleitet von #development/<id>): Die Tabelle klappt die Zeile auf,
    // hier wird nur hingescrollt.
    effect(() => {
      const id = this.store.focusId();
      if (!id || !this.store.attentionIds().has(id)) return;
      untracked(() =>
        globalThis.setTimeout(() => {
          const target = document.getElementById(`order-${id}`)?.closest('tr')?.previousElementSibling;
          (target ?? document.querySelector('.attention-table .row-open'))?.scrollIntoView({
            block: 'start',
            behavior: 'smooth',
          });
        }, 200),
      );
    });
  }

  /** Ohne gestarteten Behebungsauftrag stimmt „an einen Behebungsauftrag delegiert“ nicht: weglassen. */
  protected noteText(item: DevelopmentItem, note: string): string {
    return item.fixStatus ? note : note.replace(/\s*–\s*an einen Behebungsauftrag delegiert\.?$/, '.');
  }

  protected openBug(id: string): void {
    this.store.navigate('bugs', { focus: id });
  }

  /** Ein kompletter Test (oder ein anderer Nachweis-Lauf) läuft: Startknöpfe gesperrt, die API antwortet sonst 409. */
  protected readonly testRunning = computed(() => this.data().testRunning);

  protected evidenceReason(proof: TestEvidence): string {
    return EVIDENCE_REASON_LABELS[proof.grund];
  }

  /** Startknopf nur für freigegebene Befehle; sonst führt der Eintrag zu den Rechten des Agents. */
  protected canStartEvidence(proof: TestEvidence): boolean {
    return proof.allowed && proof.grund !== 'nicht_freigegeben' && proof.status !== 'nicht_freigegeben';
  }

  /** Übergibt nur die Nachweis-ID: Den Befehl liest der Worker aus der gespeicherten Zeile. */
  protected runEvidence(proof: TestEvidence): Promise<void> {
    const path = `${this.api.projectPath(this.store.activeProject())}/test-evidence/${encodeURIComponent(proof.id)}/run`;
    return this.store.perform(
      () => this.api.post(path),
      'Testlauf gestartet – grün hakt den Nachweis ab, das Ergebnis steht unter „Testläufe“.',
    );
  }

  /** Rechte-Gruppen (Einstellungen › Rechte-Kategorien) aufgeklappt öffnen; zugewiesen werden sie beim Agent. */
  protected openRights(): void {
    this.settingsGroups.set('rechte', true);
    this.store.navigate('settings', { anchor: 'permission-groups' });
  }

  protected openRun(id: string): void {
    this.store.navigate('runs', { focus: id });
  }

  protected analyzeOrder(item: DevelopmentItem): Promise<void> {
    return this.orders.analyze(item);
  }

  /** Hover-Text eines Knopfs (was der Klick bewirkt). */
  protected hint(label: string): string {
    return actionHint(label);
  }

  protected confirmOrder(item: DevelopmentItem): Promise<void> {
    return this.orders.confirmChecks(item);
  }

  protected checkPoint(item: DevelopmentItem, check: AcceptanceCheck): Promise<void> {
    return this.orders.checkPoint(item, check, true);
  }

  /** „Ansicht“ samt „Optisch freigeben“ oben in der Karte (dieselbe Regel wie in der Auftragsansicht). */
  protected showVisual(item: DevelopmentItem): boolean {
    const visual = this.data().acceptance.filter((check) => check.developmentId === item.id && check.kind === 'visual');
    return needsVisual(item, visual.length);
  }

  /** Meldung des Agents nur zeigen, wenn sie mehr sagt als „Warum“ oben (sonst stünde derselbe Satz zweimal da). */
  protected repeatsWhy(report: string, why: string): boolean {
    const plain = (text: string): string =>
      text
        .replace(/[`*_#>]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/[.…]+$/, '');
    const shown = plain(why);
    const full = plain(report);
    return !full || full === shown || shown.startsWith(full);
  }

  protected entryOf(id: string): AttentionEntry | null {
    return this.entries().get(id) ?? null;
  }

  protected detailsOpen(id: string): boolean {
    return this.detailsShown().has(id);
  }

  protected toggleDetails(id: string): void {
    this.detailsShown.update((shown) => {
      const next = new Set(shown);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  protected approve(item: DevelopmentItem): Promise<void> {
    return this.orders.approve(item);
  }

  protected reject(item: DevelopmentItem): Promise<void> {
    return this.orders.rejectReview(item);
  }

  protected note(id: string): string {
    return this.notes()[id] ?? '';
  }

  protected setNote(id: string, value: string): void {
    this.notes.update((notes) => ({ ...notes, [id]: value }));
  }

  /** Antwortfeld nur, wo eine Antwort den Auftrag weiterbringt (blockiert und neu startbar). */
  protected canAnswer(item: DevelopmentItem, step: CardStep): boolean {
    return (
      item.status === 'blocked' &&
      item.kind !== 'express' &&
      this.auth.can('run') &&
      (step === 'retry' || step === 'suggestion' || step === 'task')
    );
  }

  /** Die eine Hauptaktion der Zeile; null, wenn es nichts zu klicken gibt (z. B. Behebung läuft). */
  protected primaryLabel(item: DevelopmentItem, step: CardStep): string | null {
    switch (step) {
      case 'suggestion':
        return this.auth.can('run') ? 'So umsetzen lassen' : null;
      case 'retry':
      case 'task':
        return item.kind !== 'express' && this.auth.can('run') ? 'Erneut versuchen' : null;
      case 'rule':
        return this.auth.can('run') ? 'Angepasst – erneut versuchen' : null;
      case 'replan':
        return this.auth.can('run') ? 'Wieder einplanen' : null;
      case 'check':
        return this.auth.can('plan') ? 'Geprüft – alles in Ordnung' : null;
      default:
        return null;
    }
  }

  /**
   * Hauptaktion ausführen – immer erst nach Bestätigung im Dialog. Beim Vorschlag gehen Vorschlag und deine
   * Ergänzung gemeinsam an die Agents; die Ergänzung ersetzt den Vorschlag nicht.
   */
  protected async primary(item: DevelopmentItem, card: AttentionCard, label: string): Promise<void> {
    if (card.step === 'check') return this.confirmOrder(item);
    const done = await this.orders.retryNow(item, {
      label,
      note: this.note(item.id),
      suggestion: card.step === 'suggestion' ? card.detail : null,
    });
    if (done) this.setNote(item.id, '');
  }
}
