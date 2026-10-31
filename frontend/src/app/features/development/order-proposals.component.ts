import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { AuthService } from '../../core/auth.service.js';
import type { DevelopmentItem, FollowUpProposal } from '../../core/models.js';
import { ProjectStore } from '../../core/project-store.js';
import { MarkdownPipe } from '../../shared/markdown.pipe.js';
import { DEVELOPMENT_STATUS } from '../../../../../src/core/status.js';
import { OrderService } from './order.service.js';

/**
 * Bestätigungsliste: Vorschläge aus den Abschnitten „Offen“, „TODO“, „Bekannter Befund“ und „Folgeauftrag“ der
 * Auftragsdoku. Erst „Annehmen“ legt einen Bug bzw. eine Idee an; Knöpfe nur mit dem Recht „Planung“ (wie die Route).
 */
@Component({
  selector: 'app-order-proposals',
  standalone: true,
  imports: [MarkdownPipe],
  template: `
    @if (visible()) {
      <details class="run-step order-brief order-proposals" [open]="proposals().length > 0">
        <summary>
          Vorschläge aus der Doku
          @if (proposals().length) {
            <span class="count">{{ proposals().length }}</span>
          }
        </summary>
        @if (proposals().length) {
          <ul class="proposal-list plain-list">
            @for (proposal of proposals(); track proposal.id) {
              <li class="proposal-item">
                <p class="proposal-title">
                  <span class="tag" [class.tag-bug]="proposal.kind === 'bug'">{{
                    proposal.kind === 'bug' ? 'Bug' : 'Idee'
                  }}</span>
                  <strong>{{ proposal.title }}</strong>
                  <small class="muted">aus „{{ proposal.section }}“</small>
                </p>
                @if (proposal.description && proposal.description !== proposal.title) {
                  <div class="markdown proposal-text" [innerHTML]="proposal.description | markdown"></div>
                }
                @if (auth.can('plan')) {
                  <div class="actions">
                    <button
                      class="button primary small"
                      type="button"
                      [disabled]="busy()"
                      (click)="decide(proposal, 'accept')"
                    >
                      ✓ Annehmen als {{ proposal.kind === 'bug' ? 'Bug' : 'Idee' }}
                    </button>
                    <button
                      class="button secondary small"
                      type="button"
                      [disabled]="busy()"
                      (click)="decide(proposal, 'dismiss')"
                    >
                      Verwerfen
                    </button>
                  </div>
                }
              </li>
            }
          </ul>
          @if (!auth.can('plan')) {
            <p class="muted small">Annehmen und Verwerfen braucht das Recht „Planung“.</p>
          }
        } @else {
          <p class="muted">Keine offenen Vorschläge.</p>
        }
      </details>
    }
  `,
})
export class OrderProposalsComponent {
  private readonly orders = inject(OrderService);
  private readonly store = inject(ProjectStore);
  protected readonly auth = inject(AuthService);
  protected readonly busy = this.store.busy;

  readonly order = input.required<DevelopmentItem>();
  protected readonly proposals = signal<FollowUpProposal[]>([]);
  private readonly decided = signal(false);
  /** Der Dokumentierer läuft am Ende: vorher gibt es keine Vorschläge, die Liste bliebe leer. */
  protected readonly visible = computed(
    () =>
      this.proposals().length > 0 ||
      this.decided() ||
      this.order().status === DEVELOPMENT_STATUS.done ||
      this.order().status === DEVELOPMENT_STATUS.approval,
  );

  /** Eigener Schlüssel: Jeder Live-Refresh liefert ein neues Auftragsobjekt, geladen wird nur bei echter Änderung. */
  private readonly key = computed(() => `${this.order().id}:${this.order().status}`);

  constructor() {
    // Neu laden, wenn ein anderer Auftrag gezeigt wird oder sein Status wechselt (Dokumentierer fertig).
    effect(() => {
      this.key();
      void this.load(untracked(this.order));
    });
  }

  private async load(item: DevelopmentItem): Promise<void> {
    try {
      this.proposals.set(await this.orders.followUpProposals(item));
    } catch {
      this.proposals.set([]);
    }
  }

  protected async decide(proposal: FollowUpProposal, decision: 'accept' | 'dismiss'): Promise<void> {
    await this.orders.decideProposal(proposal, decision);
    // Auch nach 409 (schon entschieden) neu laden: Die Liste zeigt dann den tatsächlichen Stand.
    this.decided.set(true);
    await this.load(this.order());
  }
}
