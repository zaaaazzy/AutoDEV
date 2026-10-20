import { computed, effect, inject, Injectable, signal } from '@angular/core';
import { ApiService } from './api.service.js';
import { errorMessage } from './errors.js';
import { ProjectStore } from './project-store.js';

/** Eine gespeicherte Aktion eines Agents, z. B. „Tests ausführen“ des Testers. */
export interface AgentAction {
  id: string;
  title: string;
  prompt: string;
  agentId: string | null;
  agentName: string | null;
  runCount: number;
  lastRunAt: string | null;
  /** Zeitplan (Cron, 5 Felder, Europe/Zurich); null = nur per Klick. */
  schedule?: string | null;
  enabled?: boolean;
  nextRunAt?: string | null;
  outputTarget?: OutputTarget;
  runWindow?: string | null;
  lastStatus?: 'queued' | 'running' | 'ok' | 'failed' | null;
  /** Letzter Fehler bzw. Pausengrund. */
  lastError?: string | null;
  failureStreak?: number;
  /** Aus einer Routine-Vorlage (nur lesend gedacht). */
  template?: string | null;
  lastRun?: { status: TaskRun['status']; startedAt: string; durationMs: number | null; tokens: number } | null;
}

export type OutputTarget = 'chat' | 'push' | 'bug' | 'idea' | 'order';

export const OUTPUT_TARGET_LABELS: Record<OutputTarget, string> = {
  chat: 'nur Chat',
  push: 'Push-Meldung',
  bug: 'Bug',
  idea: 'Idee',
  order: 'Auftrag im Backlog',
};

/** Ein Lauf einer Agent-Aufgabe (Zeitplan oder Klick). */
export interface TaskRun {
  id: string;
  trigger: 'schedule' | 'manual';
  status: 'queued' | 'running' | 'ok' | 'failed' | 'cancelled';
  environmentError: boolean;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  tokens: number;
  error: string | null;
  notes: string[];
  createdItems: { kind: 'bug' | 'idea' | 'order'; id: string; title: string }[];
}

export interface ActionForm {
  id: string | null;
  title: string;
  prompt: string;
  agentId: string | null;
  /** Nur mitgeschickt, wenn das Formular den Zeitplan bearbeitet; sonst bleibt er unverändert. */
  schedule?: string | null;
  outputTarget?: OutputTarget;
  runWindow?: string | null;
  enabled?: boolean;
}

/**
 * Aktionen je Agent für das aktive Projekt – eine Quelle für das Aktionen-Menü im Assistenten und die Agents-Seite.
 * Gestartet wird eine Aktion als Anfrage an ihren Agent (Ergebnis im Chat und unter Dokumentation → Anfragen).
 */
@Injectable({ providedIn: 'root' })
export class AgentActionsService {
  private readonly api = inject(ApiService);
  private readonly store = inject(ProjectStore);
  readonly actions = signal<AgentAction[]>([]);
  readonly busy = signal(false);

  /** Aktionen je Agent-ID ('' = allgemeiner Assistent). */
  readonly byAgent = computed(() => {
    const map = new Map<string, AgentAction[]>();
    for (const action of this.actions())
      map.set(action.agentId ?? '', [...(map.get(action.agentId ?? '') ?? []), action]);
    return map;
  });

  constructor() {
    effect(() => {
      const slug = this.store.activeProject();
      this.actions.set([]);
      if (slug) void this.load();
    });
  }

  async load(): Promise<void> {
    const slug = this.store.activeProject();
    if (!slug) return;
    const result = await this.api
      .get<{ tasks: AgentAction[] }>(`${this.api.projectPath(slug)}/agent-tasks`)
      .catch(() => null);
    if (result && slug === this.store.activeProject()) this.actions.set(result.tasks);
  }

  async run(action: AgentAction, comment = ''): Promise<boolean> {
    if (this.busy()) return false;
    this.busy.set(true);
    try {
      await this.api.post(`/api/agent-tasks/${encodeURIComponent(action.id)}/run`, { comment });
      this.store.notice.set(`„${action.title}“ gestartet – ${action.agentName ?? 'der Assistent'} arbeitet daran.`);
      await this.load();
      return true;
    } catch (error) {
      this.store.notice.set(errorMessage(error, 'Aktion konnte nicht gestartet werden.'));
      return false;
    } finally {
      this.busy.set(false);
    }
  }

  async save(form: ActionForm): Promise<AgentAction | null> {
    if (this.busy()) return null;
    this.busy.set(true);
    try {
      const body: Record<string, unknown> = {
        title: form.title.trim(),
        prompt: form.prompt.trim(),
        agentId: form.agentId || null,
      };
      if (form.schedule !== undefined) body['schedule'] = form.schedule;
      if (form.outputTarget !== undefined) body['outputTarget'] = form.outputTarget;
      if (form.runWindow !== undefined) body['runWindow'] = form.runWindow;
      if (form.enabled !== undefined) body['enabled'] = form.enabled;
      const saved = form.id
        ? await this.api.patch<AgentAction>(`/api/agent-tasks/${encodeURIComponent(form.id)}`, body)
        : await this.api.post<AgentAction>(`${this.api.projectPath(this.store.activeProject())}/agent-tasks`, body);
      await this.load();
      return saved;
    } catch (error) {
      this.store.notice.set(errorMessage(error, 'Aktion konnte nicht gespeichert werden.'));
      return null;
    } finally {
      this.busy.set(false);
    }
  }

  /** Verlauf einer Aufgabe: die letzten Läufe (neueste zuerst). */
  async runs(action: AgentAction): Promise<TaskRun[]> {
    const result = await this.api
      .get<{ runs: TaskRun[] }>(`/api/agent-tasks/${encodeURIComponent(action.id)}/runs`)
      .catch(() => null);
    return result?.runs ?? [];
  }

  /** Routine pausieren bzw. fortsetzen (Fortsetzen setzt die Fehlerzählung zurück). */
  async setPaused(action: AgentAction, paused: boolean): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    try {
      await this.api.post(`/api/agent-tasks/${encodeURIComponent(action.id)}/${paused ? 'pause' : 'resume'}`, {});
      this.store.notice.set(paused ? `„${action.title}“ pausiert.` : `„${action.title}“ läuft wieder nach Zeitplan.`);
      await this.load();
    } catch (error) {
      this.store.notice.set(errorMessage(error, 'Zeitplan konnte nicht geändert werden.'));
    } finally {
      this.busy.set(false);
    }
  }

  async remove(action: AgentAction): Promise<void> {
    if (!globalThis.confirm(`Aktion „${action.title}“ löschen?`)) return;
    await this.api.delete(`/api/agent-tasks/${encodeURIComponent(action.id)}`).catch(() => undefined);
    await this.load();
  }
}
