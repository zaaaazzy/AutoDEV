import { computed, effect, inject, Injectable, signal } from '@angular/core';
import { ApiService } from './api.service.js';
import { errorMessage } from './errors.js';
import { ProjectStore } from './project-store.js';

/** Eine gespeicherte Aktion eines Agents (Quick Action), z. B. „Tests ausführen“ des Testers. */
export interface AgentAction {
  id: string;
  title: string;
  prompt: string;
  agentId: string | null;
  agentName: string | null;
  runCount: number;
  lastRunAt: string | null;
}

export interface ActionForm {
  id: string | null;
  title: string;
  prompt: string;
  agentId: string | null;
}

/**
 * Aktionen je Agent für das aktive Projekt – eine Quelle für Aktionen-Menü im Assistenten, Agents-Seite und
 * Quick Actions im Dashboard. Gestartet wird eine Aktion als Anfrage an ihren Agent (Ergebnis im Chat und unter
 * Dokumentation → Anfragen).
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

  async run(action: AgentAction): Promise<boolean> {
    if (this.busy()) return false;
    this.busy.set(true);
    try {
      await this.api.post(`/api/agent-tasks/${encodeURIComponent(action.id)}/run`, {});
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
      const body = { title: form.title.trim(), prompt: form.prompt.trim(), agentId: form.agentId || null };
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

  async remove(action: AgentAction): Promise<void> {
    if (!globalThis.confirm(`Aktion „${action.title}“ löschen?`)) return;
    await this.api.delete(`/api/agent-tasks/${encodeURIComponent(action.id)}`).catch(() => undefined);
    await this.load();
  }
}
