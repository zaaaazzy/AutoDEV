import { DatePipe } from '@angular/common';
import { Component, computed, DestroyRef, ElementRef, inject, input, signal, viewChild } from '@angular/core';
import { type ActionForm, type AgentAction, AgentActionsService } from '../../core/agent-actions.service.js';
import { ApiService } from '../../core/api.service.js';
import { AuthService } from '../../core/auth.service.js';
import type { TestRequest } from '../../core/models.js';
import { ProjectStore } from '../../core/project-store.js';

const normalize = (value: string) => value.toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '');
const POLL_MS = 10_000;

/** Ein Eintrag im Dropdown: gespeicherte Agent-Aktion oder einer der fest eingebauten Testläufe. */
export interface MenuEntry {
  key: string;
  title: string;
  /** Einzeilige Kurzbeschreibung in der Liste. */
  summary: string;
  /** Ausführliche Anweisung bzw. Beschreibung für die Hover-Details. */
  detail: string;
  /** Wer die Aktion ausführt. */
  runner: string;
  /** Was beim Start passiert. */
  effect: string;
  /** Befehle, die dabei laufen (falls bekannt). */
  commands: string[];
  action?: AgentAction;
  scope?: 'full' | 'ui';
}

export interface MenuGroup {
  id: string;
  name: string;
  entries: MenuEntry[];
}

/** Fest eingebaute Testläufe: laufen beim Worker über scripts/test-full.ts, Befunde werden Bugs. */
const TEST_ENTRIES: MenuEntry[] = [
  {
    key: 'test:full',
    scope: 'full',
    title: 'Kompletter Test',
    summary: 'Alle Teststufen inkl. Playwright-Oberflächentest; Befunde werden Bugs',
    detail:
      'Prüft das Projekt vollständig: Lint, Formatierung, Typen, Unit-Tests, E2E-Tests und den Oberflächentest mit Klick-Test (Playwright, Desktop und Handy, mit Screenshots und Video). Jeder Befund wird als Bug angelegt.',
    runner: 'Worker (Testlauf)',
    effect:
      'Der Worker startet den Test, sobald kein Auftrag läuft. Ergebnis, Screenshots und Videos stehen danach unter Testläufe.',
    commands: [
      'npm run lint',
      'npm run format:check',
      'npm run typecheck',
      'npm test',
      'npm run test:e2e',
      'Playwright-Oberflächentest',
    ],
  },
  {
    key: 'test:ui',
    scope: 'ui',
    title: 'Nur Oberfläche',
    summary: 'Nur der Playwright-Oberflächentest: jede Seite, jeder Knopf und Link',
    detail:
      'Nur der Playwright-Oberflächentest: öffnet jede Seite und klickt jeden Knopf und Link, auf Desktop und Handy, mit Screenshots und Video. Jeder Befund wird als Bug angelegt.',
    runner: 'Worker (Testlauf)',
    effect:
      'Der Worker startet den Test, sobald kein Auftrag läuft. Ergebnis, Screenshots und Videos stehen danach unter Testläufe.',
    commands: ['npm run test:full -- --nur-oberflaeche'],
  },
];

/** Befehle aus einer Anweisung: Angaben in Backticks oder in Klammern wie „(z. B. npm outdated, npm audit)“. */
export function promptCommands(prompt: string): string[] {
  const ticks = [...prompt.matchAll(/`([^`]+)`/g)].map((match) => (match[1] ?? '').trim());
  const parens = [...prompt.matchAll(/\(([^)]+)\)/g)]
    .flatMap((match) => (match[1] ?? '').replace(/^z\.\s*B\.\s*/, '').split(','))
    .map((part) => part.trim())
    .filter((part) => /^(npm|npx|docker|git|pnpm|yarn|node|make)\b/.test(part));
  return [...new Set([...ticks, ...parens])];
}

/**
 * Alle Aktionen im Assistenten: Testläufe und gespeicherte Agent-Aufgaben, gruppiert nach Agent, per Dropdown
 * suchen und mit einem Klick starten. Hover oder Tastatur zeigt die ausführliche Beschreibung.
 */
@Component({
  selector: 'app-agent-tasks',
  standalone: true,
  imports: [DatePipe],
  templateUrl: './agent-tasks.component.html',
  host: { class: 'agent-tasks', '(document:click)': 'outside($event)', '(keydown.escape)': 'close()' },
})
export class AgentTasksComponent {
  private readonly api = inject(ApiService);
  protected readonly store = inject(ProjectStore);
  private readonly host = inject(ElementRef<HTMLElement>);
  protected readonly actions = inject(AgentActionsService);
  protected readonly auth = inject(AuthService);
  protected readonly open = signal(false);
  protected readonly query = signal('');
  protected readonly active = signal(0);
  /** Details nur, solange die Maus auf einem Eintrag ist oder mit der Tastatur gewählt wurde. */
  protected readonly showDetail = signal(false);
  protected readonly busy = this.actions.busy;
  /** Letzter angeforderter Testlauf des Projekts. */
  protected readonly latestTest = signal<TestRequest | null>(null);
  protected readonly testBusy = computed(
    () => this.store.busy() || ['requested', 'running'].includes(this.latestTest()?.status ?? ''),
  );
  /** Formular: null = geschlossen, id null = neue Aktion. */
  protected readonly editing = signal<ActionForm | null>(null);
  /** Im Chat gewählter Agent: Vorgabe für neue Aktionen. */
  readonly agentId = input<string | null>(null);
  /** Agents des Projekts, denen eine Aktion gehören kann. */
  protected readonly agents = computed(() => this.store.data().agents.filter((agent) => agent.enabled));
  private readonly search = viewChild<ElementRef<HTMLInputElement>>('search');

  /** Alle Einträge je Gruppe, gefiltert: Tests, dann Agents in Workflow-Reihenfolge, zuletzt der Assistent. */
  protected readonly groups = computed<MenuGroup[]>(() => {
    const terms = normalize(this.query()).split(/\s+/).filter(Boolean);
    const matches = (entry: MenuEntry) => {
      const text = normalize(`${entry.title} ${entry.detail} ${entry.runner}`);
      return terms.every((term) => text.includes(term));
    };
    const toEntry = (action: AgentAction, runner: string): MenuEntry => ({
      key: action.id,
      title: action.title,
      summary: action.prompt,
      detail: action.prompt,
      runner,
      effect: `Geht als Anfrage an ${runner}. Ergebnis und Rückfragen erscheinen im Chat und unter Dokumentation → Anfragen; die Do's and Don'ts des Projekts gelten.`,
      commands: promptCommands(action.prompt),
      action,
    });
    const byAgent = this.actions.byAgent();
    const groups: MenuGroup[] = [];
    if (this.auth.can('run')) groups.push({ id: 'tests', name: 'Tests', entries: TEST_ENTRIES });
    for (const agent of this.store.data().agents) {
      const own = byAgent.get(agent.id);
      if (own) groups.push({ id: agent.id, name: agent.name, entries: own.map((a) => toEntry(a, agent.name)) });
    }
    // Aktionen ohne (bekannten) Agent gehören dem allgemeinen Assistenten.
    const known = new Set(this.store.data().agents.map((agent) => agent.id));
    const general = this.actions.actions().filter((action) => !action.agentId || !known.has(action.agentId));
    if (general.length) {
      groups.push({
        id: 'assistant',
        name: 'Assistent (allgemein)',
        entries: general.map((a) => toEntry(a, a.agentName ?? 'den Assistenten')),
      });
    }
    return groups
      .map((group) => ({ ...group, entries: group.entries.filter(matches) }))
      .filter((group) => group.entries.length);
  });

  /** Alle sichtbaren Einträge in Listenreihenfolge (für Tastatur und Index). */
  protected readonly entries = computed(() => this.groups().flatMap((group) => group.entries));
  protected readonly current = computed(() => (this.showDetail() ? this.entries()[this.active()] : undefined));

  constructor() {
    // Solange ein Test wartet oder läuft und das Menü offen ist, den Stand regelmäßig nachladen.
    const timer = globalThis.setInterval(() => {
      if (this.open() && ['requested', 'running'].includes(this.latestTest()?.status ?? '')) void this.loadTests();
    }, POLL_MS);
    inject(DestroyRef).onDestroy(() => globalThis.clearInterval(timer));
  }

  protected position(entry: MenuEntry): number {
    return this.entries().indexOf(entry);
  }

  protected toggle(): void {
    if (this.open()) return this.close();
    this.open.set(true);
    this.query.set('');
    this.active.set(0);
    this.showDetail.set(false);
    this.editing.set(null);
    void this.actions.load();
    if (this.auth.can('run')) void this.loadTests();
    setTimeout(() => this.search()?.nativeElement.focus());
  }

  protected close(): void {
    this.open.set(false);
    this.editing.set(null);
  }

  protected outside(event: MouseEvent): void {
    // composedPath statt contains: Knöpfe, die beim Klick aus dem DOM verschwinden, zählen nicht als „daneben“.
    if (this.open() && !event.composedPath().includes(this.host.nativeElement)) this.close();
  }

  protected setQuery(value: string): void {
    this.query.set(value);
    this.active.set(0);
  }

  /** Hover nur mit der Maus: auf Touch-Geräten öffnet der Info-Knopf die Details. */
  protected hover(index: number, event: PointerEvent): void {
    if (event.pointerType !== 'mouse') return;
    this.active.set(index);
    this.showDetail.set(true);
  }

  protected leave(event: PointerEvent): void {
    if (event.pointerType === 'mouse') this.showDetail.set(false);
  }

  /** Details per Knopf: auf Touch-Geräten gibt es kein Hover, ein Tippen auf den Eintrag startet ihn. */
  protected details(index: number, event: Event): void {
    event.stopPropagation();
    this.active.set(index);
    this.showDetail.set(true);
  }

  protected keydown(event: KeyboardEvent): void {
    const count = this.entries().length;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!count) return;
      // Erster Pfeil zeigt die Details des markierten Eintrags, weitere wandern durch die Liste.
      if (this.showDetail()) this.active.set((this.active() + (event.key === 'ArrowDown' ? 1 : count - 1)) % count);
      this.showDetail.set(true);
      setTimeout(() =>
        this.host.nativeElement.querySelector('.agent-task.active')?.scrollIntoView?.({ block: 'nearest' }),
      );
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const entry = this.entries()[this.active()];
      if (entry) void this.run(entry);
    }
  }

  protected disabled(entry: MenuEntry): boolean {
    return entry.scope ? this.testBusy() : this.busy();
  }

  protected async run(entry: MenuEntry): Promise<void> {
    if (this.disabled(entry)) return;
    if (entry.scope) {
      await this.requestTest(entry.scope);
      this.close();
    } else if (entry.action && (await this.actions.run(entry.action))) this.close();
  }

  protected startNew(): void {
    this.editing.set({ id: null, title: this.query().trim(), prompt: '', agentId: this.agentId() });
  }

  protected edit(action: AgentAction, event: Event): void {
    event.stopPropagation();
    this.editing.set({ id: action.id, title: action.title, prompt: action.prompt, agentId: action.agentId });
  }

  protected async save(title: string, prompt: string, agentId: string, andRun: boolean): Promise<void> {
    const form = this.editing();
    if (!form) return;
    const saved = await this.actions.save({ ...form, title, prompt, agentId: agentId || null });
    if (!saved) return;
    this.editing.set(null);
    if (andRun) {
      if (await this.actions.run(saved)) this.close();
    } else this.store.notice.set(`Aktion „${saved.title}“ gespeichert.`);
  }

  protected async remove(action: AgentAction, event: Event): Promise<void> {
    event.stopPropagation();
    await this.actions.remove(action);
  }

  protected manage(): void {
    this.close();
    this.store.navigate('agents');
  }

  private async requestTest(scope: 'full' | 'ui'): Promise<void> {
    const slug = this.store.activeProject();
    await this.store.perform(
      async () => {
        const { request } = await this.api.post<{ request: TestRequest }>(
          `${this.api.projectPath(slug)}/test-requests`,
          { scope },
        );
        this.latestTest.set(request);
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
      if (slug === this.store.activeProject()) this.latestTest.set(requests?.[0] ?? null);
    } catch {
      /* nächster Versuch beim nächsten Takt */
    }
  }
}
