import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { ApiService } from '../core/api.service.js';
import { AuthService } from '../core/auth.service.js';
import { errorMessage } from '../core/errors.js';
import type { DevelopmentItem } from '../core/models.js';
import { ConfirmService } from '../core/confirm.service.js';
import { ProjectStore } from '../core/project-store.js';
import { hashParameter, targetFromHash } from '../core/navigation.js';

/** Offene Rückfrage eines Agents zu einer Express-Anfrage (GET /api/development/:id/question). */
export interface OrderQuestion {
  id: string;
  question: string;
  options: string[] | null;
  agentName: string | null;
  createdAt: string;
}

/**
 * Zeigt die Rückfrage direkt im Auftrag und nimmt die Antwort dort entgegen. Die Antwort geht als Antwort auf genau
 * diese Rückfrage an denselben Agent (wie im Chat); der Auftrag aktualisiert sich danach von selbst.
 */
@Component({
  selector: 'app-order-question',
  standalone: true,
  template: `
    @if (question(); as current) {
      <div class="order-question">
        <span class="order-question-label">❓ Rückfrage von {{ current.agentName ?? 'dem Assistenten' }}</span>
        <p>{{ current.question }}</p>
        @if (auth.can('chat')) {
          @if (current.options?.length) {
            <div class="order-question-options" role="group" aria-label="Antwort wählen">
              @for (option of current.options; track option) {
                <button class="button secondary small" type="button" [disabled]="sending()" (click)="answer(option)">
                  {{ option }}
                </button>
              }
            </div>
          }
          <form (submit)="$event.preventDefault(); answer(text())">
            <textarea
              [id]="'answer-' + order().id"
              rows="2"
              maxlength="4000"
              aria-label="Eigene Antwort"
              placeholder="Eigene Antwort …"
              [value]="text()"
              (input)="text.set($any($event.target).value)"
            ></textarea>
            <button class="button primary" type="submit" [disabled]="sending() || !text().trim()">Antworten</button>
          </form>
        } @else {
          <small class="muted">Antworten braucht das Recht, mit dem Assistenten zu arbeiten.</small>
        }
      </div>
    } @else if (sent()) {
      <p class="muted">Antwort gesendet – der Agent arbeitet weiter. Der Auftrag aktualisiert sich von selbst.</p>
    }
  `,
})
export class OrderQuestionComponent {
  private readonly api = inject(ApiService);
  private readonly store = inject(ProjectStore);
  private readonly confirm = inject(ConfirmService);
  protected readonly auth = inject(AuthService);

  readonly order = input.required<DevelopmentItem>();
  protected readonly question = signal<OrderQuestion | null>(null);
  protected readonly text = signal('');
  protected readonly sending = signal(false);
  protected readonly sent = signal(false);

  /** Neu laden nur, wenn sich Auftrag oder offene Aktion ändern – nicht bei jedem Nachladen der Projektdaten. */
  private readonly key = computed(() => `${this.order().id}\n${this.order().actionTodo ?? ''}`);
  /** Aus der Push-Nachricht „Rückfrage“: nur einmal ins Antwortfeld springen, nicht bei jedem Nachladen. */
  private jumped = false;

  constructor() {
    effect(() => {
      // Neu laden, sobald sich der Auftrag ändert (z. B. neue Rückfrage nach einer Antwort).
      this.key();
      untracked(() => void this.load(this.order().id));
    });
  }

  private async load(id: string): Promise<void> {
    const result = await this.api
      .get<{ question: OrderQuestion | null }>(`/api/development/${encodeURIComponent(id)}/question`)
      .catch(() => null);
    if (id !== this.order().id) return;
    this.question.set(result?.question ?? null);
    if (result?.question) {
      this.sent.set(false);
      // Aus der Push-Nachricht „Rückfrage“ geöffnet: direkt ins Antwortfeld.
      if (!this.jumped && targetFromHash() === id && hashParameter('answer') === '1') {
        this.jumped = true;
        globalThis.setTimeout(() => {
          const field = globalThis.document?.getElementById(`answer-${id}`);
          field?.scrollIntoView({ block: 'center' });
          field?.focus();
        }, 200);
      }
    }
  }

  protected async answer(content: string): Promise<void> {
    const current = this.question();
    const reply = content.trim();
    if (!current || !reply || this.sending()) return;
    const ok = await this.confirm.ask({
      title: 'Antwort senden?',
      message: `Der Agent bekommt diese Antwort auf seine Rückfrage zu „${this.order().title}“ und arbeitet weiter.`,
      details: [reply],
      confirmLabel: 'Antwort senden',
      withoutComment: true,
    });
    if (!ok || this.question()?.id !== current.id) return;
    this.sending.set(true);
    try {
      const slug = this.store.activeProject();
      await this.api.post(`${this.api.projectPath(slug)}/chat`, { content: reply, replyTo: current.id });
      this.text.set('');
      this.question.set(null);
      this.sent.set(true);
      this.store.notice.set('Antwort gesendet – der Agent arbeitet weiter.');
      void this.store.loadProject(slug, true);
    } catch (error) {
      this.store.notice.set(errorMessage(error, 'Antwort konnte nicht gesendet werden.'));
    } finally {
      this.sending.set(false);
    }
  }
}
