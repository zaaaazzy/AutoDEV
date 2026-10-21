import { AgentOutputPipe } from '../../shared/agent-output.pipe.js';
import { NgClass } from '@angular/common';
import { Component, computed, effect, HostListener, inject, signal } from '@angular/core';
import { ApiService } from '../../core/api.service.js';
import type { TestCase, TestCaseStatus, TestCategory, TestMedia, TestRun } from '../../core/models.js';
import { targetFromHash } from '../../core/navigation.js';
import { ProjectStore } from '../../core/project-store.js';
import {
  type DataColumn,
  DataCellDirective,
  DataDetailDirective,
  DataTableComponent,
} from '../../shared/data-table/data-table.component.js';
import { formatDuration } from '../../shared/format.js';
import { statusLabel } from '../../shared/labels.js';
import { DurationPipe, StatusClassPipe, StatusLabelPipe } from '../../shared/pipes.js';
import { summarizeOutput } from './output-summary.js';
import { StepSummaryComponent } from './step-summary.component.js';

export const CATEGORIES: { id: TestCategory; label: string; hint: string }[] = [
  { id: 'quality', label: 'Qualität', hint: 'Lint, Formatierung, Typen, Build' },
  { id: 'unit', label: 'Unit', hint: 'Einzelne Funktionen und Module' },
  { id: 'e2e', label: 'E2E', hint: 'Abläufe im Browser, Desktop und Handy' },
  { id: 'user', label: 'User', hint: 'Kompletter Oberflächentest wie ein Mensch' },
];
const CASE_STATUS_LABEL: Record<TestCaseStatus, string> = {
  passed: 'Bestanden',
  failed: 'Fehlgeschlagen',
  skipped: 'Übersprungen',
  flaky: 'Wackelig',
};
const TRIGGER_LABEL: Record<string, string> = { ci: 'CI', full: 'Komplettlauf', manual: 'Manuell' };
const TREND_RUNS = 12;
const PLATFORM_LABEL: Record<string, string> = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' };
/** Sicht (Bereich der Anwendung), erkannt am Testnamen; die erste passende Regel gewinnt. */
const AREAS: [string, RegExp][] = [
  [
    'Navigation & Bedienung',
    /tabelle|sortier|filter|navigation|alle (seiten|bereiche)|überlauf|menü|knopf|link|begrüßung|tour/i,
  ],
  [
    'Anmeldung & Sicherheit',
    /login|anmeld|rolle|role|admin|autorin|benutzer|passw|scrypt|lock|limiter|totp|rfc 6238|time step|https|same-origin|credential|secret|sqlviolation|auth|session/i,
  ],
  ['Git & Repository', /\bgit\b|commit|remote|github|branch|favicon/i],
  ['Dashboard & Chat', /dashboard|chat|assistent|erwähnung|mention|verweis|kommentar|split lines|final answer/i],
  ['Ideen', /idee|ideas?\b|ideation|visionär|estimate|effort|benefit/i],
  [
    'Aufträge',
    /auftrag|aufträge|order|development|abnahme|acceptance|follow-up|problem|analyse|aktion|handlungsbedarf|kurzfassung|hinweis/i,
  ],
  ['Sprints', /sprint|kanban|board|autopilot|arbeitszeit/i],
  ['Bugs', /\bbugs?\b/i],
  ['Dokumentation', /doku|\bdocs?\b|handbuch|markdown|testbericht|shorttitle/i],
  [
    'Testläufe & Qualität',
    /test-?lauf|testläufe|coverage|testabdeckung|\btap\b|playwright|vitest|jest|lint|locator|measured|kurzfazit|script arguments|tester report/i,
  ],
  [
    'Agents & Worker',
    /agent|runner|worker|delegation|ollama|claude|werkzeug|tool|befehl|command|wächter|hook|model|loopguard|reviewer|prompt|freigabe|fails honestly|reports (new|recovery)/i,
  ],
  [
    'Einstellungen & Projekte',
    /einstellung|setting|projekt|project|push|manifest|service worker|wizard|setup|template|folder|ordner|application shell|bundle|attachment|image/i,
  ],
];

interface CategoryStats {
  id: TestCategory;
  label: string;
  hint: string;
  passed: number;
  failed: number;
  skipped: number;
  total: number;
  /** Status dieser Kategorie in den letzten Läufen (älteste zuerst); null = nicht gelaufen. */
  trend: { runId: string; state: 'passed' | 'failed' | null; startedAt: string }[];
}

/** Medium samt Test, zu dem es gehört (für Galerie und Großansicht). */
interface MediaItem extends TestMedia {
  testCase: TestCase;
  url: string;
}

@Component({
  selector: 'app-runs',
  standalone: true,
  imports: [
    NgClass,
    AgentOutputPipe,
    DataTableComponent,
    DataCellDirective,
    DataDetailDirective,
    DurationPipe,
    StatusClassPipe,
    StatusLabelPipe,
    StepSummaryComponent,
  ],
  templateUrl: './runs.component.html',
  host: { style: 'display: contents' },
})
export class RunsComponent {
  private readonly api = inject(ApiService);
  protected readonly store = inject(ProjectStore);
  protected readonly data = this.store.data;
  protected readonly categories = CATEGORIES;
  protected readonly openRun = signal<string | null>(null);
  protected readonly openCase = signal<string | null>(null);
  /** Gewählter Lauf für die Übersicht; ohne Wahl der neueste. */
  protected readonly chosenRun = signal<string | null>(null);
  protected readonly category = signal<TestCategory | null>(null);
  /** Gruppierung der Tabelle „Alle Tests“ (Spalten-ID) und geöffneter Prüfschritt. */
  protected readonly groupBy = signal<string | null>('area');
  protected readonly openStep = signal<number | null>(null);
  protected readonly groupOptions = [
    { id: '', label: 'nicht gruppieren' },
    { id: 'category', label: 'Kategorie' },
    { id: 'area', label: 'Sicht' },
    { id: 'method', label: 'Methode' },
    { id: 'device', label: 'Gerät' },
    { id: 'status', label: 'Status' },
  ];
  protected readonly cases = signal<TestCase[]>([]);
  protected readonly casesLoading = signal(false);
  protected readonly casesError = signal('');
  protected readonly viewer = signal<MediaItem | null>(null);

  protected readonly runs = computed(() =>
    [...this.data().runs].sort((left, right) => right.startedAt.localeCompare(left.startedAt)),
  );
  protected readonly selected = computed<TestRun | null>(
    () => this.runs().find((run) => run.id === this.chosenRun()) ?? this.runs()[0] ?? null,
  );

  protected readonly stats = computed<CategoryStats[]>(() => {
    const run = this.selected();
    const recent = this.runs().slice(0, TREND_RUNS).reverse();
    return CATEGORIES.map((category) => {
      const counts = run ? countsOf(run, category.id) : { passed: 0, failed: 0, skipped: 0 };
      return {
        ...category,
        ...counts,
        total: counts.passed + counts.failed + counts.skipped,
        trend: recent.map((entry) => ({
          runId: entry.id,
          state: stateOf(entry, category.id),
          startedAt: entry.startedAt,
        })),
      };
    }).filter((category) => category.total > 0 || category.trend.some((point) => point.state));
  });

  /** Erfolgsquote der letzten Läufe und Dauer des gewählten Laufs. */
  protected readonly headline = computed(() => {
    const finished = this.runs()
      .slice(0, 10)
      .filter((run) => run.status !== 'running');
    const passed = finished.filter((run) => run.status === 'passed').length;
    const run = this.selected();
    const duration = run?.completedAt && run.startedAt ? Date.parse(run.completedAt) - Date.parse(run.startedAt) : null;
    return {
      rate: finished.length ? Math.round((passed / finished.length) * 100) : null,
      finished: finished.length,
      duration: duration === null ? '–' : formatDuration(duration),
    };
  });

  protected readonly visibleCases = computed(() => {
    const category = this.category();
    return this.cases().filter((testCase) => !category || testCase.category === category);
  });
  protected readonly findings = computed(() =>
    this.visibleCases().filter((testCase) => testCase.status === 'failed' || testCase.status === 'flaky'),
  );
  protected readonly media = computed<MediaItem[]>(() =>
    this.visibleCases().flatMap((testCase) =>
      testCase.media.map((file) => ({ ...file, testCase, url: this.mediaUrl(file) })),
    ),
  );
  protected readonly images = computed(() => this.media().filter((file) => file.mime.startsWith('image/')));
  protected readonly videos = computed(() => this.media().filter((file) => file.mime.startsWith('video/')));
  /** Fehlgeschlagene Schritte ohne Einzeltests (Lint, Formatierung, Typen, Build) gelten ebenfalls als Befund. */
  protected readonly failedChecks = computed(() =>
    this.qualitySteps().filter((step) => step.category === 'quality' && step.status === 'failed'),
  );
  protected readonly findingCount = computed(() => this.findings().length + this.failedChecks().length);
  protected readonly qualitySteps = computed(() =>
    (this.selected()?.steps ?? []).filter((step) => !this.category() || step.category === this.category()),
  );

  protected readonly caseId = (testCase: TestCase): string => testCase.id;
  protected readonly caseColumns: DataColumn<TestCase>[] = [
    {
      id: 'category',
      header: 'Kategorie',
      value: (testCase) => categoryLabel(testCase.category),
      sortValue: (testCase) => CATEGORIES.findIndex((category) => category.id === testCase.category),
    },
    { id: 'title', header: 'Test', value: (testCase) => testCase.title, filter: 'text', className: 'title-cell' },
    { id: 'area', header: 'Sicht', value: (testCase) => this.areaOf(testCase) },
    { id: 'method', header: 'Methode', value: (testCase) => this.methodOf(testCase) },
    { id: 'device', header: 'Gerät', value: (testCase) => this.deviceOf(testCase) },
    {
      id: 'status',
      header: 'Status',
      value: (testCase) => CASE_STATUS_LABEL[testCase.status],
      sortValue: (testCase) => ['failed', 'flaky', 'skipped', 'passed'].indexOf(testCase.status),
    },
    {
      id: 'duration',
      header: 'Dauer',
      value: (testCase) => (testCase.durationMs === null ? '–' : formatDuration(testCase.durationMs)),
      sortValue: (testCase) => testCase.durationMs ?? 0,
      filter: false,
    },
    {
      id: 'media',
      header: 'Medien',
      value: (testCase) => testCase.media.length || '–',
      sortValue: (testCase) => testCase.media.length,
      filter: false,
    },
  ];

  protected readonly runId = (run: TestRun): string => run.id;
  protected readonly runColumns: DataColumn<TestRun>[] = [
    {
      id: 'startedAt',
      header: 'Gestartet',
      value: (run) => new Date(run.startedAt).toLocaleString('de-CH', { dateStyle: 'short', timeStyle: 'short' }),
      sortValue: (run) => run.startedAt,
      filter: false,
      className: 'title-cell',
    },
    { id: 'status', header: 'Status', value: (run) => statusLabel(run.status) },
    { id: 'trigger', header: 'Auslöser', value: (run) => triggerLabel(run.trigger) },
    { id: 'tests', header: 'Tests', value: (run) => summaryText(run), filter: false },
    { id: 'branch', header: 'Branch', value: (run) => run.branch || 'ohne Branch' },
    {
      id: 'commit',
      header: 'Commit',
      value: (run) => run.commitSha?.slice(0, 8) || '–',
      filter: 'text',
    },
  ];

  constructor() {
    // Link aus einem Testbericht (#runs/<id>): diesen Lauf in der Übersicht zeigen.
    const target = targetFromHash();
    if (target) this.chosenRun.set(target);
    // Einzeltests des gewählten Laufs nachladen, sobald sich Lauf oder Projekt ändern.
    effect(() => {
      const run = this.selected();
      const slug = this.store.activeProject();
      void this.loadCases(slug, run);
    });
  }

  /** Was diese Kategorie im Lauf geprüft hat, z. B. „Lint · Formatierung · Typprüfung“ oder „155 Tests“. */
  protected checksOf(entry: CategoryStats): string {
    const steps = (this.selected()?.steps ?? []).filter((step) => step.category === entry.id);
    if (entry.id === 'quality') {
      return steps.map((step) => stepName(step.command)).join(' · ') || entry.hint;
    }
    if (!entry.total) return entry.hint;
    return `${entry.total} ${entry.total === 1 ? 'Test' : 'Tests'} · ${entry.hint}`;
  }

  /** Verlauf nur aus Läufen, in denen die Kategorie dabei war (älteste zuerst). */
  protected historyOf(entry: CategoryStats): { runId: string; state: 'passed' | 'failed'; startedAt: string }[] {
    return entry.trend.filter(
      (point): point is { runId: string; state: 'passed' | 'failed'; startedAt: string } => point.state !== null,
    );
  }

  protected historyText(entry: CategoryStats): string {
    const points = this.historyOf(entry);
    if (!points.length) return 'noch kein Verlauf';
    const green = points.filter((point) => point.state === 'passed').length;
    return `${green} von ${points.length} grün`;
  }

  protected historyTitle(point: { runId: string; state: string; startedAt: string }, currentId: string): string {
    const date = new Date(point.startedAt).toLocaleString('de-CH', { dateStyle: 'short', timeStyle: 'short' });
    return `${date} · ${point.state === 'passed' ? 'bestanden' : 'fehlgeschlagen'}${point.runId === currentId ? ' · dieser Lauf' : ''}`;
  }

  protected areaOf(testCase: TestCase): string {
    const text = `${testCase.title} ${testCase.file ?? ''}`;
    return AREAS.find(([, pattern]) => pattern.test(text))?.[0] ?? 'Allgemein';
  }

  /** API-Methode aus Testname oder Meldungen; Oberflächentests ohne Methode heißen „UI“. */
  protected methodOf(testCase: TestCase): string {
    const method = /\b(GET|POST|PUT|PATCH|DELETE)\b/.exec(`${testCase.title} ${testCase.errors.join(' ')}`)?.[1];
    return method ?? (testCase.category === 'unit' ? '–' : 'UI');
  }

  /** Gerät (PC/Handy) und Betriebssystem des Laufs, z. B. „PC · macOS“. */
  protected deviceOf(testCase: TestCase): string {
    const platform = PLATFORM_LABEL[this.selected()?.platform ?? ''] ?? '';
    const device = testCase.device ? deviceLabel(testCase.device) : '';
    return [device, platform].filter(Boolean).join(' · ') || '–';
  }

  protected stepHeadline(step: { command: string; output: string; status: string }): string {
    return summarizeOutput(step.command, step.output ?? '', step.status).headline;
  }

  /** Befund eines fehlgeschlagenen Prüfschritts: Schritt unter „Alle Tests“ öffnen. */
  protected openFailedStep(stepPosition: number): void {
    this.openStep.set(stepPosition);
    queueMicrotask(() =>
      document.getElementById(`step-${stepPosition}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
    );
  }

  protected choose(run: TestRun): void {
    this.chosenRun.set(run.id);
    this.openCase.set(null);
  }

  protected toggleCategory(category: TestCategory): void {
    this.category.set(this.category() === category ? null : category);
  }

  protected percent(part: number, total: number): number {
    return total ? Math.round((part / total) * 100) : 0;
  }

  protected caseStatusLabel(status: TestCaseStatus): string {
    return CASE_STATUS_LABEL[status];
  }

  protected categoryLabel(category: TestCategory): string {
    return categoryLabel(category);
  }

  protected deviceLabel(device: string | null): string {
    return deviceLabel(device);
  }

  protected triggerLabel(trigger: string): string {
    return triggerLabel(trigger);
  }

  protected runDate(run: TestRun): string {
    return new Date(run.startedAt).toLocaleString('de-CH', { dateStyle: 'medium', timeStyle: 'short' });
  }

  protected mediaUrl(file: TestMedia): string {
    return this.api.url(`/api/test-media/${encodeURIComponent(file.id)}`);
  }

  protected showCase(testCase: TestCase): void {
    this.openCase.set(testCase.id);
    this.viewer.set(null);
    queueMicrotask(() => document.getElementById('test-cases')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  }

  protected open(file: MediaItem): void {
    this.viewer.set(file);
  }

  protected openMedia(file: TestMedia, testCase: TestCase): void {
    this.viewer.set({ ...file, testCase, url: this.mediaUrl(file) });
  }

  protected step(offset: number): void {
    const items = this.images();
    const current = this.viewer();
    if (!current || !items.length) return;
    const index = items.findIndex((item) => item.id === current.id);
    this.viewer.set(items[(index + offset + items.length) % items.length] ?? null);
  }

  @HostListener('document:keydown', ['$event'])
  protected onKey(event: KeyboardEvent): void {
    if (!this.viewer()) return;
    if (event.key === 'Escape') this.viewer.set(null);
    if (event.key === 'ArrowRight') this.step(1);
    if (event.key === 'ArrowLeft') this.step(-1);
  }

  private async loadCases(slug: string, run: TestRun | null): Promise<void> {
    if (!slug || !run) {
      this.cases.set([]);
      return;
    }
    this.casesLoading.set(true);
    this.casesError.set('');
    try {
      const result = await this.api.get<{ cases?: TestCase[] }>(
        `${this.api.projectPath(slug)}/test-runs/${encodeURIComponent(run.id)}/cases`,
      );
      if (this.selected()?.id === run.id) this.cases.set(result.cases ?? []);
    } catch {
      this.cases.set([]);
      this.casesError.set('Einzeltests konnten nicht geladen werden.');
    } finally {
      this.casesLoading.set(false);
    }
  }
}

function countsOf(run: TestRun, category: TestCategory): { passed: number; failed: number; skipped: number } {
  const summary = run.summary?.[category];
  if (summary && Object.keys(summary).length) {
    return {
      passed: summary.passed ?? 0,
      failed: (summary.failed ?? 0) + (summary.flaky ?? 0),
      skipped: summary.skipped ?? 0,
    };
  }
  // Ohne Einzeltests zählen die Schritte dieser Kategorie (z. B. Lint, Build oder ältere Läufe)
  const steps = run.steps.filter((step) => step.category === category);
  return {
    passed: steps.filter((step) => step.status === 'passed').length,
    failed: steps.filter((step) => step.status === 'failed').length,
    skipped: 0,
  };
}

function stateOf(run: TestRun, category: TestCategory): 'passed' | 'failed' | null {
  const counts = countsOf(run, category);
  if (counts.failed) return 'failed';
  return counts.passed ? 'passed' : null;
}

function categoryLabel(category: TestCategory): string {
  return CATEGORIES.find((entry) => entry.id === category)?.label ?? category;
}

function deviceLabel(device: string | null): string {
  if (!device) return '–';
  return device === 'handy' ? 'Handy' : device === 'desktop' ? 'PC' : device;
}

/** Kurzname eines Prüfbefehls: „npm run format:check“ → „Formatierung“. */
function stepName(command: string): string {
  if (/lint|eslint/.test(command)) return 'Lint';
  if (/format|prettier/.test(command)) return 'Formatierung';
  if (/typecheck|tsc/.test(command)) return 'Typprüfung';
  if (/build/.test(command)) return 'Build';
  return command.replace(/^npm (run )?/, '');
}

function triggerLabel(trigger: string): string {
  return TRIGGER_LABEL[trigger] ?? 'Manuell';
}

function summaryText(run: TestRun): string {
  const parts = CATEGORIES.map((category) => {
    const counts = countsOf(run, category.id);
    const total = counts.passed + counts.failed + counts.skipped;
    if (!total) return '';
    return `${category.label} ${counts.passed}/${total - counts.skipped}`;
  }).filter(Boolean);
  return parts.join(' · ') || `${run.steps.length} Schritte`;
}
