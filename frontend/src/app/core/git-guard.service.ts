import { Injectable, computed, inject } from '@angular/core';
import { ApiService } from './api.service.js';
import { ConfirmService, type ConfirmOptions } from './confirm.service.js';
import { problemsForAction } from './git-problems.js';
import type { GitFix, GitProblem, GuardedAction } from './models.js';
import { ProjectStore } from './project-store.js';

export const FIX_LABEL: Record<GitFix, string> = {
  save_wip: 'Zwischenstand sichern',
  checkout_main: 'Zurück auf main',
  sync_main: 'main mit GitHub abgleichen',
};

const FIX_EXPLAIN: Record<GitFix, string[]> = {
  save_wip: [
    'Alle offenen Änderungen werden committet – auf dem aktuellen Branch, auf main stattdessen auf einem neuen Branch „wip/…“.',
    'Nichts geht verloren; Dateien, die nach Zugangsdaten aussehen, bleiben draussen.',
    'Arbeitet gerade jemand von Hand in diesem Ordner, landet sein Zwischenstand im Commit.',
  ],
  checkout_main: [
    'Der Ordner wechselt auf main. Der bisherige Branch bleibt erhalten.',
    'Nur ohne offene Änderungen möglich.',
  ],
  sync_main: [
    'main wird mit GitHub zusammengeführt (Fast-Forward oder Merge-Commit) und normal gepusht – nie mit Force.',
    'Bei einem Konflikt bricht AIdeation ab und meldet es.',
  ],
};

/**
 * Git-Zustand der Projektordner in der Oberfläche: Befunde je Aktion, Lösungen anfordern und vor riskanten Aktionen
 * nachfragen. Die Sperre selbst prüft der Server; hier wird nur rechtzeitig erklärt und „trotzdem“ angeboten.
 */
@Injectable({ providedIn: 'root' })
export class GitGuardService {
  private readonly store = inject(ProjectStore);
  private readonly api = inject(ApiService);
  private readonly confirm = inject(ConfirmService);

  readonly status = computed(() => this.store.worker().git ?? null);
  private readonly separate = computed(
    () => !!this.status()?.state?.folders.some((folder) => folder.role === 'agents'),
  );
  /** Befunde des aktuellen Stands; ein veralteter Stand (Worker aus) zählt nicht. */
  readonly problems = computed(() => {
    const status = this.status();
    return status && !status.stale ? (status.state?.problems ?? []) : [];
  });
  readonly fixRunning = computed(() => {
    const fix = this.status()?.fix;
    return fix && (fix.status === 'requested' || fix.status === 'running') ? fix : null;
  });

  forAction(action: GuardedAction | 'all'): GitProblem[] {
    return problemsForAction(this.problems(), this.separate(), action);
  }

  blocking(action: GuardedAction | 'all'): GitProblem[] {
    return this.forAction(action).filter((problem) => problem.severity === 'block');
  }

  /**
   * Bestätigung vor einer riskanten Aktion. Ohne sperrenden Befund der normale Dialog; sonst ein Warn-Dialog, der
   * die Befunde zeigt und „trotzdem“ nur mit Begründung erlaubt. null = abgebrochen, sonst Zusatzfelder für den Request.
   */
  async confirmAction(
    action: GuardedAction,
    options: ConfirmOptions,
    overrideLabel: string,
  ): Promise<{ comment: string; body: Record<string, unknown> } | null> {
    const problems = this.blocking(action);
    if (!problems.length) {
      const answer = await this.confirm.ask(options);
      return answer && { comment: answer.comment, body: {} };
    }
    const answer = await this.confirm.ask({
      title: `${options.title.replace(/\?$/, '')} – Git-Zustand nicht sauber`,
      message:
        'Im Projektordner liegt etwas, das diese Aktion gefährdet. Am besten zuerst beheben – die Lösungen stehen im roten Hinweis. Du kannst trotzdem fortfahren.',
      details: problems.map((problem) => `${problem.title}: ${problem.detail}`),
      confirmLabel: overrideLabel,
      danger: true,
      commentLabel: 'Warum trotzdem? (Pflicht)',
      commentRequired: true,
      commentPlaceholder: 'z. B. „Die offenen Dateien sind nur Notizen, geprüft.“',
      commentHint: 'Wird im Worker-Protokoll festgehalten.',
    });
    return answer && { comment: '', body: { ignoreGit: true, gitReason: answer.comment } };
  }

  /** Lösung anfordern (nach Bestätigung); der Worker führt sie aus, das Ergebnis erscheint im Hinweis. */
  async requestFix(problem: GitProblem, fix: GitFix): Promise<void> {
    const ok = await this.confirm.ask({
      title: `${FIX_LABEL[fix]}?`,
      message: `Betrifft ${problem.folder}.`,
      details: FIX_EXPLAIN[fix],
      confirmLabel: FIX_LABEL[fix],
      withoutComment: true,
    });
    if (!ok) return;
    await this.store.perform(
      () => this.api.post(`${this.api.projectPath(this.store.activeProject())}/git-fix`, { fix, role: problem.role }),
      `${FIX_LABEL[fix]} angefordert – der Worker erledigt das gleich.`,
    );
    void this.store.refreshWorker();
  }
}
