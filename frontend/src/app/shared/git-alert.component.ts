import { Component, computed, inject, input } from '@angular/core';
import { AuthService } from '../core/auth.service.js';
import { FIX_LABEL, GitGuardService } from '../core/git-guard.service.js';
import type { GitProblem, GuardedAction } from '../core/models.js';
import { ProjectStore } from '../core/project-store.js';

const ACTION_TEXT: Record<GuardedAction, string> = {
  go_live: 'Live schalten ist gesperrt, bis das gelöst ist.',
  approve: 'Freigeben ist gesperrt, bis das gelöst ist.',
  sprint_start: 'Sprint starten ist gesperrt, bis das gelöst ist.',
};

/**
 * Hinweis zum Git-Zustand der Projektordner mit Lösungen auf Knopfdruck. `action` zeigt nur, was die Aktion betrifft
 * (Sprint: Live schalten, Auftrag: Freigeben); `compact` ist die Kurzform fürs Sprint-Menü in der Kopfzeile.
 */
@Component({
  selector: 'app-git-alert',
  standalone: true,
  template: `
    @let problems = shown();
    @if (problems.length || lastFix(); as _) {
      @if (compact()) {
        @if (problems.length) {
          <a class="git-alert-compact" [class.block]="blocks()" href="#dashboard" (click)="openDashboard($event)">
            {{ blocks() ? '⛔' : '⚠️' }} Git: {{ problems[0]!.title
            }}{{ problems.length > 1 ? ' (+' + (problems.length - 1) + ')' : '' }}
          </a>
        }
      } @else {
        <section class="git-alert" [class.block]="blocks()" role="status" aria-live="polite">
          @if (problems.length) {
            <header>
              <strong>{{ blocks() ? 'Git-Zustand verhindert Aktionen' : 'Hinweis zum Git-Zustand' }}</strong>
              @if (blocks() && action() !== 'all') {
                <span>{{ actionText() }}</span>
              }
            </header>
            <ul>
              @for (problem of problems; track problem.role + problem.code) {
                <li [class.block]="problem.severity === 'block'">
                  <span class="git-alert-title">{{ problem.title }}</span>
                  <span class="git-alert-detail">{{ problem.detail }}</span>
                  @if (canFix() && problem.fixes.length) {
                    <span class="git-alert-fixes">
                      @for (fix of problem.fixes; track fix) {
                        <button
                          type="button"
                          class="button secondary small"
                          [disabled]="store.busy() || !!running()"
                          (click)="guard.requestFix(problem, fix)"
                        >
                          {{ label(fix) }}
                        </button>
                      }
                    </span>
                  }
                </li>
              }
            </ul>
          }
          @if (running(); as fix) {
            <p class="git-alert-status">⏳ {{ label(fix.fix) }} läuft …</p>
          } @else if (lastFix(); as fix) {
            <p class="git-alert-status" [class.failed]="fix.status === 'failed'">
              {{ fix.status === 'failed' ? '⚠️' : '✓' }} {{ label(fix.fix) }}: {{ fix.message }}
            </p>
          }
        </section>
      }
    }
  `,
})
export class GitAlertComponent {
  protected readonly guard = inject(GitGuardService);
  protected readonly store = inject(ProjectStore);
  private readonly auth = inject(AuthService);
  readonly action = input<GuardedAction | 'all'>('all');
  readonly compact = input(false);

  protected readonly shown = computed<GitProblem[]>(() => this.guard.forAction(this.action()));
  protected readonly blocks = computed(() => this.shown().some((problem) => problem.severity === 'block'));
  protected readonly running = this.guard.fixRunning;
  /** Ergebnis der letzten Lösung, solange es frisch ist (10 Minuten). */
  protected readonly lastFix = computed(() => {
    const fix = this.guard.status()?.fix;
    if (!fix || fix.status === 'requested' || fix.status === 'running' || !fix.finishedAt) return null;
    return Date.now() - new Date(fix.finishedAt).getTime() < 10 * 60_000 ? fix : null;
  });
  protected readonly canFix = computed(() => this.auth.can('run'));
  protected readonly actionText = computed(() => {
    const action = this.action();
    return action === 'all' ? '' : ACTION_TEXT[action];
  });

  protected label(fix: keyof typeof FIX_LABEL): string {
    return FIX_LABEL[fix];
  }

  protected openDashboard(event: Event): void {
    event.preventDefault();
    this.store.navigate('dashboard');
  }
}
