import { DatePipe } from '@angular/common';
import { Component, computed, DestroyRef, ElementRef, inject, input, signal, viewChild } from '@angular/core';
import { type ActionForm, type AgentAction, AgentActionsService } from '../../core/agent-actions.service.js';
import { ApiService } from '../../core/api.service.js';
import { AuthService } from '../../core/auth.service.js';
import type { TestRequest, VisionaryRun } from '../../core/models.js';
import { ProjectStore } from '../../core/project-store.js';
import { ConfirmService } from '../../core/confirm.service.js';

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
  /** Startet einen Visionär-Lauf (wie „Ideen vorschlagen lassen“ in Ideation). */
  visionary?: boolean;
  /** Startet AIdeation neu (Container neu bauen, Worker neu starten). */
  restart?: boolean;
}

/** Stand des Neustarts von AIdeation (GET/POST /api/system/restart). */
export interface RestartState {
  status: 'requested' | 'building' | 'restarting' | 'done' | 'failed';
  requestedAt: string;
  requestedBy: string | null;
  finishedAt?: string | null;
  message?: string | null;
  log?: string | null;
}

const RESTART_OPEN = ['requested', 'building', 'restarting'];

/** AIdeation neu starten: neuer Code und neue Agents werden geladen (nur Administration). */
const RESTART_ENTRY: MenuEntry = {
  key: 'system:restart',
  restart: true,
  title: 'AIdeation neu starten',
  summary: 'Container neu bauen und Worker neu starten – lädt neuen Code und neue Agents',
  detail:
    'Baut alle AIdeation-Container mit dem aktuellen Code neu (docker compose up -d --build) und startet danach den Worker neu, damit auch er den neuen Code und die neuen Agents lädt. Laufende Aufgaben werden abgewartet (höchstens 15 Minuten); was dann noch läuft, wird nach dem Neustart fortgesetzt.',
  runner: 'Worker (auf dem Rechner)',
  effect:
    'Das Dashboard ist während des Neustarts kurz nicht erreichbar und verbindet sich danach selbst neu. Der Stand steht hier im Menü.',
  commands: ['docker compose up -d --build', 'Worker-Neustart (launchd)'],
};

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

/** Visionär: liest das Projekt nur lesend und legt begründete Erweiterungsideen in Ideation an. */
const VISIONARY_ENTRY: MenuEntry = {
  key: 'visionary',
  visionary: true,
  title: 'Visionär: Ideen vorschlagen lassen',
  summary: 'Liest das Projekt (nur lesend) und schlägt begründete Erweiterungsideen vor',
  detail:
    'Der Visionär sieht sich Projektbeschreibung, Doku, Dateibaum, Sprintberichte, Bugs, offene Aufträge und Testabdeckung an und schlägt neue Ideen mit Begründung vor. Dubletten zu offenen oder abgelehnten Ideen legt er nicht an; Ablehnungsgründe beachtet er beim nächsten Lauf.',
  runner: 'Visionär (Worker)',
  effect:
    'Der Worker startet den Lauf. Die Ideen erscheinen unter Ideation mit dem Badge „Visionär“ – dort lassen sie sich übernehmen oder mit Grund ablehnen.',
  commands: [],
};

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
  private readonly confirm = inject(ConfirmService);
  protected readonly open = signal(false);
  protected readonly query = signal('');
  protected readonly active = signal(0);
  /** Details nur, solange die Maus auf einem Eintrag ist oder mit der Tastatur gewählt wurde. */
  protected readonly showDetail = signal(false);
  /** Details wurden per Pfeiltaste geöffnet (Maus-Verlassen schliesst sie dann nicht). */
  private keyboardDetail = false;
  protected readonly busy = this.actions.busy;
  /** Letzter angeforderter Testlauf des Projekts. */
  protected readonly latestTest = signal<TestRequest | null>(null);
  protected readonly testBusy = computed(
    () => this.store.busy() || ['requested', 'running'].includes(this.latestTest()?.status ?? ''),
  );
  /** Letzter Visionär-Lauf des Projekts; solange er offen ist, ist der Eintrag gesperrt. */
  protected readonly latestVisionary = signal<VisionaryRun | null>(null);
  protected readonly visionaryOpen = computed(() =>
    ['requested', 'running'].includes(this.latestVisionary()?.status ?? ''),
  );
  /** Letzter Neustart von AIdeation; solange er läuft, ist der Eintrag gesperrt. */
  protected readonly latestRestart = signal<RestartState | null>(null);
  protected readonly restartOpen = computed(() => RESTART_OPEN.includes(this.latestRestart()?.status ?? ''));
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
    if (this.auth.can('plan')) groups.push({ id: 'visionary', name: 'Visionär', entries: [VISIONARY_ENTRY] });
    if (this.auth.can('admin')) {
      const restart = this.latestRestart();
      const summary = restart?.message && restart.status !== 'done' ? restart.message : RESTART_ENTRY.summary;
      const detail =
        restart?.status === 'failed' && restart.log
          ? `${RESTART_ENTRY.detail}\n\nLetzter Versuch fehlgeschlagen:\n${restart.log.slice(-600)}`
          : RESTART_ENTRY.detail;
      groups.push({ id: 'system', name: 'System', entries: [{ ...RESTART_ENTRY, summary, detail }] });
    }
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
      if (this.open() && this.visionaryOpen()) void this.loadVisionary();
      if (this.open() && this.restartOpen()) void this.loadRestart();
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
    if (this.auth.can('plan')) void this.loadVisionary();
    if (this.auth.can('admin')) void this.loadRestart();
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
    if (event.pointerType !== 'mouse' || this.keyboardDetail) return;
    this.active.set(index);
    this.showDetail.set(true);
  }

  protected leave(event: PointerEvent): void {
    // Per Tastatur geöffnete Details nicht schliessen, nur weil sich die Liste unter der stehenden Maus verschoben hat.
    if (event.pointerType === 'mouse' && !this.keyboardDetail) this.showDetail.set(false);
  }

  /** Erst eine echte Mausbewegung über der Liste übergibt die Details wieder an die Maus. */
  protected moved(): void {
    this.keyboardDetail = false;
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
      this.keyboardDetail = true;
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
    if (entry.visionary) return this.store.busy() || this.visionaryOpen();
    if (entry.restart) return this.store.busy() || this.restartOpen();
    return entry.scope ? this.testBusy() : this.busy();
  }

  /** Jede Schnellaktion startet erst nach Bestätigung im eigenen Dialog, optional mit Kommentar. */
  protected async run(entry: MenuEntry): Promise<void> {
    if (this.disabled(entry)) return;
    this.close();
    const answer = await this.confirm.ask({
      title: `„${entry.title}“ starten?`,
      message: entry.effect,
      details: entry.commands.length ? entry.commands.map((command) => `$ ${command}`) : undefined,
      confirmLabel: 'Starten',
      commentLabel: entry.visionary ? 'Schwerpunkt (optional)' : 'Kommentar (optional)',
      commentPlaceholder: entry.visionary
        ? 'z. B. „Ideen rund um Benachrichtigungen“'
        : entry.action
          ? 'z. B. „Nur das Backend prüfen“'
          : '',
      commentHint: entry.visionary
        ? 'Der Visionär richtet die Vorschläge dieses Laufs danach aus.'
        : entry.action
          ? `Wird der Anweisung an ${entry.runner} als Hinweis angehängt.`
          : entry.restart
            ? 'Wird mit dem Neustart vermerkt.'
            : 'Wird mit dem Testlauf gespeichert.',
    });
    if (!answer) return;
    if (entry.visionary) await this.startVisionary(answer.comment);
    else if (entry.restart) await this.requestRestart(answer.comment);
    else if (entry.scope) await this.requestTest(entry.scope, answer.comment);
    else if (entry.action) await this.actions.run(entry.action, answer.comment);
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
      const runner = saved.agentName ?? 'den Assistenten';
      await this.run(
        this.entries().find((candidate) => candidate.action?.id === saved.id) ?? {
          key: saved.id,
          title: saved.title,
          summary: saved.prompt,
          detail: saved.prompt,
          runner,
          effect: `Geht als Anfrage an ${runner}. Ergebnis und Rückfragen erscheinen im Chat.`,
          commands: promptCommands(saved.prompt),
          action: saved,
        },
      );
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

  private async requestTest(scope: 'full' | 'ui', comment = ''): Promise<void> {
    const slug = this.store.activeProject();
    await this.store.perform(
      async () => {
        const { request } = await this.api.post<{ request: TestRequest }>(
          `${this.api.projectPath(slug)}/test-requests`,
          { scope, comment },
        );
        this.latestTest.set(request);
      },
      scope === 'ui'
        ? 'Oberflächentest angefordert – der Worker startet ihn gleich.'
        : 'Kompletter Test angefordert – der Worker startet ihn gleich.',
      false,
    );
  }

  private async requestRestart(comment = ''): Promise<void> {
    await this.store.perform(
      async () => {
        const { restart } = await this.api.post<{ restart: RestartState }>('/api/system/restart', { comment });
        this.latestRestart.set(restart);
      },
      'Neustart angefordert – der Worker baut die Container neu und startet danach selbst neu.',
      false,
    );
  }

  private async loadRestart(): Promise<void> {
    try {
      const { restart } = await this.api.get<{ restart: RestartState | null }>('/api/system/restart');
      this.latestRestart.set(restart);
    } catch {
      /* während des Neustarts ist die API kurz weg – nächster Versuch beim nächsten Takt */
    }
  }

  private visionaryPath(): string {
    return `${this.api.projectPath(this.store.activeProject())}/ideation/visionary`;
  }

  private async startVisionary(comment = ''): Promise<void> {
    await this.store.perform(
      async () => {
        const { run } = await this.api.post<{ run: VisionaryRun }>(this.visionaryPath(), { comment });
        this.latestVisionary.set(run);
      },
      'Visionär-Lauf gestartet – die Ideen erscheinen unter Ideation.',
      false,
    );
  }

  private async loadVisionary(): Promise<void> {
    const slug = this.store.activeProject();
    try {
      const { run } = await this.api.get<{ run: VisionaryRun | null }>(this.visionaryPath());
      if (slug === this.store.activeProject()) this.latestVisionary.set(run);
    } catch {
      /* nächster Versuch beim nächsten Takt */
    }
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
