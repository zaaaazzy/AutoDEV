import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { ApiService } from '../../core/api.service.js';
import { ProjectStore } from '../../core/project-store.js';
import { formatDuration } from '../../shared/format.js';
import { type LiveRun, type LiveStep, liveStepMs, liveStepName } from './test-run-live.js';

const POLL_MS = 3_000;

/**
 * Live-Anzeige eines laufenden Testlaufs (Komplettlauf, Test-Gate der Sprint-Sicherung, Testanforderung): fragt alle
 * drei Sekunden den Stand ab, zeigt jeden Schritt mit Fortschritt und lädt die Testläufe neu, sobald er fertig ist.
 */
@Component({
  selector: 'app-test-run-live',
  standalone: true,
  template: `
    @if (live(); as run) {
      <section class="panel test-live" aria-live="polite">
        <div class="section-heading">
          <div>
            <h2><span class="test-live-dot" aria-hidden="true"></span> Testlauf läuft</h2>
            <p class="muted">
              seit {{ elapsed() }} · Schritt {{ current() }} von {{ run.steps.length }}
              @if (run.branch) {
                · {{ run.branch }}
              }
            </p>
          </div>
        </div>
        <ol class="test-live-steps">
          @for (step of run.steps; track step.position) {
            <li [class]="'test-live-step ' + step.status">
              <span class="test-live-icon" aria-hidden="true">{{
                step.status === 'passed' ? '✅' : step.status === 'failed' ? '❌' : '⏳'
              }}</span>
              <span class="test-live-name">{{ name(step.command) }}</span>
              <span class="test-live-time">{{ stepTime(step) }}</span>
              @if (step.status === 'running') {
                <span class="test-live-progress">{{ step.progress || 'läuft …' }}</span>
                @if (step.output) {
                  <details class="test-live-output">
                    <summary>Ausgabe live</summary>
                    <pre>{{ step.output }}</pre>
                  </details>
                }
              }
            </li>
          }
        </ol>
      </section>
    }
  `,
})
export class TestRunLiveComponent {
  private readonly api = inject(ApiService);
  private readonly store = inject(ProjectStore);
  protected readonly live = signal<LiveRun | null>(null);
  protected readonly name = liveStepName;

  protected readonly current = computed(() => {
    const steps = this.live()?.steps ?? [];
    const running = steps.findIndex((step) => step.status === 'running');
    return running >= 0 ? running + 1 : steps.length;
  });
  protected readonly elapsed = computed(() => {
    const run = this.live();
    return run ? formatDuration(Math.max(0, Date.parse(run.now) - Date.parse(run.startedAt))) : '';
  });

  constructor() {
    let busy = false;
    const poll = async (): Promise<void> => {
      if (busy || globalThis.document?.hidden) return;
      busy = true;
      try {
        const slug = this.store.activeProject();
        const { run } = await this.api.get<{ run: LiveRun | null }>(`${this.api.projectPath(slug)}/test-runs/live`);
        const was = this.live();
        this.live.set(run);
        // Gerade fertig geworden: Ergebnis, Einzeltests und Medien in der Liste darunter nachladen.
        if (was && (!run || run.id !== was.id)) void this.store.loadProject(slug, true);
      } catch {
        // Kurz nicht erreichbar: beim nächsten Takt erneut.
      } finally {
        busy = false;
      }
    };
    void poll();
    const timer = globalThis.setInterval(() => void poll(), POLL_MS);
    inject(DestroyRef).onDestroy(() => globalThis.clearInterval(timer));
  }

  protected stepTime(step: LiveStep): string {
    const ms = liveStepMs(step, this.live()?.now ?? new Date().toISOString());
    return ms === null ? '' : formatDuration(ms);
  }
}
