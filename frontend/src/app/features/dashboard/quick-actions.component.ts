import { DatePipe } from '@angular/common';
import { Component, computed, DestroyRef, effect, inject, signal } from '@angular/core';
import { AgentActionsService } from '../../core/agent-actions.service.js';
import { ApiService } from '../../core/api.service.js';
import { AuthService } from '../../core/auth.service.js';
import type { TestRequest } from '../../core/models.js';
import { ProjectStore } from '../../core/project-store.js';
import { NavIconComponent } from '../../shared/nav-icon.component.js';

const POLL_MS = 10_000;

/**
 * Quick Actions: oben der komplette Test (alle Teststufen inkl. Playwright, Befunde werden Bugs), darunter die
 * Aktionen der Agents als Knöpfe, gruppiert nach Agent; ein Klick startet sie.
 */
@Component({
  selector: 'app-quick-actions',
  standalone: true,
  imports: [DatePipe, NavIconComponent],
  template: `
    @if (store.activeProject()) {
      <section class="panel quick-actions" aria-label="Quick Actions">
        <div class="section-heading">
          <h2>Quick Actions</h2>
          <a href="#agents" (click)="$event.preventDefault(); store.navigate('agents')">Aktionen verwalten</a>
        </div>
        <div class="quick-group">
          <span class="quick-agent"><span class="mention-icon" aria-hidden="true">🧪</span>Tests</span>
          <div class="quick-buttons">
            <button
              type="button"
              class="quick-button"
              title="Lint, Formatierung, Typen, Unit, E2E und Oberflächentest mit Klick-Test (Playwright); Befunde werden Bugs"
              [disabled]="testBusy() || !auth.can('run')"
              (click)="requestTest('full')"
            >
              ▶ Kompletter Test
            </button>
            <button
              type="button"
              class="quick-button"
              title="Nur der Playwright-Oberflächentest: jede Seite, jeder Knopf und Link, Desktop und Handy"
              [disabled]="testBusy() || !auth.can('run')"
              (click)="requestTest('ui')"
            >
              ▶ Nur Oberfläche
            </button>
          </div>
          @if (latest(); as test) {
            <p class="quick-test-status" [class.failed]="test.status === 'failed'" role="status">
              @switch (test.status) {
                @case ('requested') {
                  ⏳ Wartet auf den Worker (startet, sobald kein Auftrag läuft) · angefordert
                  {{ test.createdAt | date: 'HH:mm' }}
                }
                @case ('running') {
                  <span class="typing" aria-hidden="true"><i></i><i></i><i></i></span>
                  {{ test.scope === 'ui' ? 'Oberflächentest' : 'Kompletter Test' }} läuft seit
                  {{ test.startedAt | date: 'HH:mm' }}
                }
                @case ('done') {
                  ✓ Fertig {{ test.finishedAt | date: 'dd.MM. HH:mm' }} ·
                  {{ test.bugCount ? test.bugCount + ' neue Bugs' : 'keine neuen Bugs' }}
                }
                @case ('failed') {
                  ✕ Abgebrochen: {{ test.error || 'unbekannter Fehler' }}
                }
              }
              @if (test.runId) {
                · <a [href]="'#runs/' + test.runId">Testlauf ansehen</a>
              }
            </p>
          }
        </div>
        @for (group of groups(); track group.id) {
          <div class="quick-group">
            <span class="quick-agent"
              ><span class="mention-icon" aria-hidden="true"><app-nav-icon name="agents" /></span>{{ group.name }}</span
            >
            <div class="quick-buttons">
              @for (action of group.actions; track action.id) {
                <button
                  type="button"
                  class="quick-button"
                  [title]="action.prompt"
                  [disabled]="actions.busy() || !auth.can('chat')"
                  (click)="actions.run(action)"
                >
                  ▶ {{ action.title }}
                </button>
              }
            </div>
          </div>
        }
      </section>
    }
  `,
  host: { style: 'display: contents' },
})
export class QuickActionsComponent {
  private readonly api = inject(ApiService);
  protected readonly store = inject(ProjectStore);
  protected readonly auth = inject(AuthService);
  protected readonly actions = inject(AgentActionsService);
  protected readonly latest = signal<TestRequest | null>(null);
  protected readonly testBusy = computed(
    () => this.store.busy() || ['requested', 'running'].includes(this.latest()?.status ?? ''),
  );

  constructor() {
    effect(() => {
      if (this.store.activeProject()) void this.loadTests();
    });
    // Solange ein Test wartet oder läuft, den Stand regelmäßig nachladen.
    const timer = globalThis.setInterval(() => {
      if (['requested', 'running'].includes(this.latest()?.status ?? '')) void this.loadTests();
    }, POLL_MS);
    inject(DestroyRef).onDestroy(() => globalThis.clearInterval(timer));
  }

  protected async requestTest(scope: 'full' | 'ui'): Promise<void> {
    const slug = this.store.activeProject();
    await this.store.perform(
      async () => {
        const { request } = await this.api.post<{ request: TestRequest }>(
          `${this.api.projectPath(slug)}/test-requests`,
          { scope },
        );
        this.latest.set(request);
      },
      scope === 'ui'
        ? 'Oberflächentest angefordert – der Worker startet ihn gleich.'
        : 'Kompletter Test angefordert – der Worker startet ihn gleich.',
      false,
    );
  }

  private async loadTests(): Promise<void> {
    const slug = this.store.activeProject();
    try {
      const { requests } = await this.api.get<{ requests?: TestRequest[] }>(
        `${this.api.projectPath(slug)}/test-requests`,
      );
      if (slug === this.store.activeProject()) this.latest.set(requests?.[0] ?? null);
    } catch {
      /* nächster Versuch beim nächsten Takt */
    }
  }

  /** Je Agent (in Workflow-Reihenfolge) seine Aktionen; Aktionen ohne Agent gehören dem Assistenten. */
  protected readonly groups = computed(() => {
    const byAgent = this.actions.byAgent();
    const agents = this.store.data().agents.filter((agent) => byAgent.has(agent.id));
    const groups = agents.map((agent) => ({ id: agent.id, name: agent.name, actions: byAgent.get(agent.id)! }));
    const general = byAgent.get('');
    return general?.length ? [...groups, { id: 'assistant', name: 'Assistent', actions: general }] : groups;
  });
}
