// Status- und Routing-Typen kommen aus dem Backend (dort die einzige Definition), damit beide Seiten nicht
// auseinanderlaufen.
import type { BudgetPeriod, RoutingRule } from '../../../../src/core/shared-types.js';
import type { BugStatus, DevelopmentStatus, SprintStatus } from '../../../../src/core/status.js';

export type { BudgetPeriod, RoutingCondition, RoutingRule, RuleEffect } from '../../../../src/core/shared-types.js';
export type { BugStatus, DevelopmentStatus, SprintStatus } from '../../../../src/core/status.js';

import type { CoverageAreaKey } from '../../../../src/core/coverage-areas.js';

export type { CoverageAreaKey };
export type Priority = 'low' | 'medium' | 'high';
/** review = Pull Request offen (PR-Modus der GitHub-Brücke), Merge und Tag folgen nach grüner CI. */
export type GithubMode = 'aus' | 'issues' | 'issues+pr';
/** Workflow-Phasen (Spalten im Workflow-Board); siehe src/core/workflow-phases.ts. */
export type AgentPhase = 'pre_sprint' | 'pre_task' | 'while_task' | 'after_task' | 'on_rejected' | 'on_done';

export interface Project {
  slug: string;
  name: string;
  repository: string;
  gitRemote?: string | null;
  testCommands?: string[][];
  /** Testbefehle je Auftrag (Tester-Schritt, mit {tests}/{files}); null = wie testCommands. */
  orderTestCommands?: string[][] | null;
  deployCommands?: string[][] | null;
  deployStatus?: string | null;
  description?: string;
  guidelines?: string;
  autoBugfix?: boolean;
  agentWorkspace?: boolean;
  /** Docker-Sandbox für alle Agents und Projekttests; null = globaler Schalter DEV_LOG_AGENT_SANDBOX (Standard workbench). */
  agentSandbox?: 'off' | 'docker' | 'workbench' | null;
  reviewMode?: 'off' | 'ui' | 'always';
  reviewCommand?: string[] | null;
  reviewUrl?: string | null;
  /** Kostenbremse je Auftrag (leer = keine Grenze). */
  /** AIdeation nach dem Sprint-Abschluss automatisch neu starten (AIdeation-Projekt). */
  restartAfterSprint?: boolean;
  /** Sprintplanung: manuell (Standard), vorschlagen oder Autopilot. */
  sprintMode?: 'manual' | 'suggest' | 'autopilot';
  /** Kapazität eines Sprints in Agent-Stunden (gemessene Laufzeit der Agents). */
  sprintCapacityHours?: number;
  /** Arbeitszeiten des Sprint-Autopilots (HH:MM, Wochentage 1 = Montag … 7 = Sonntag). */
  autopilotStart?: string;
  autopilotEnd?: string;
  autopilotDays?: number[];
  autopilotAutoLive?: boolean;
  databaseConfigured?: boolean;
  definitionOfReady?: string[] | null;
  definitionOfDone?: string[] | null;
  /** Stand des Favicons der Anwendung (null = keines gefunden). */
  faviconVersion?: number | null;
  /** GitHub-Brücke: Issue-Import und Rückmeldung, optional Pull Request beim Sprint-Abschluss. */
  githubMode?: GithubMode;
  /** PR-Modus: erst nach Approve eines Menschen mergen. */
  githubRequireApproval?: boolean;
  githubSyncedAt?: string | null;
  /** Ergebnis von „gh auth status“ auf dem Worker (null = noch nicht geprüft). */
  githubAuth?: 'ok' | 'missing' | null;
  githubAuthMessage?: string | null;
  githubAuthCheckedAt?: string | null;
  /** Produktions-Rückkanal: Health-URL, Compose-Dienste, Ausschlussmuster, Aufbewahrung, Ingest-Token hinterlegt. */
  healthUrl?: string | null;
  logServices?: string[];
  productionIgnore?: string[];
  productionRetentionDays?: number;
  ingestConfigured?: boolean;
  /** Visuelle Prüfung: Adresse der laufenden Vorschau, aufzunehmende Seiten und Einstellungen. */
  previewUrl?: string | null;
  previewPages?: string[];
  visualSettings?: VisualSettings;
}

export interface VisualLogin {
  path: string;
  userSelector: string;
  passwordSelector: string;
  submitSelector: string;
  /** Namen der Testwerte in der .env.example des Projekts. */
  userKey: string;
  passwordKey: string;
}

export interface VisualSettings {
  /** Ab diesem Anteil geänderter Pixel (Prozent) gilt eine Seite als geändert. */
  tolerance: number;
  threshold: number;
  masks: string[];
  login: VisualLogin | null;
  aiJudge: boolean;
  visionModel: string | null;
}

export type VisualDevice = 'desktop' | 'mobile';

export interface VisualSnapshot {
  id: string;
  developmentId: string | null;
  page: string;
  device: VisualDevice;
  kind: 'shot' | 'diff';
  diffPercent: number | null;
  baseId: string | null;
  size: number;
  createdAt: string;
}

export interface VisualApproval {
  approvedAt: string | null;
  approvedBy: string | null;
}

export type Category = 'frontend' | 'backend' | 'fullstack' | 'infrastructure' | 'docs' | 'security';

export interface Estimate {
  /** Bereich der Arbeit; Aufträge erben ihn von Idee bzw. Bug. */
  category?: Category | null;
  /** Gespeicherte Schätzung; `calibratedHours` ist sie in gemessenen Agent-Stunden (vom Board geliefert). */
  effortHours?: number | null;
  calibratedHours?: number | null;
  /** Herkunft der Schätzung: von Hand, Schnellschätzung, Auftragsautor; null = Altbestand. */
  estimateSource?: 'manual' | 'quick' | 'author' | null;
  tokenEstimate?: number | null;
  benefit?: number | null;
  cost?: number | null;
}

export interface Idea extends Estimate {
  id: string;
  title: string;
  description: string;
  status: string;
  priority: Priority;
  createdAt: string;
  agentNote?: string | null;
  /** Herkunft: von Hand erfasst oder vom Visionär vorgeschlagen (weitere Quellen folgen). */
  source?: IdeaSource;
  rejectionReason?: string | null;
  /** Art (Vergleichsgruppe der Schätzung); ohne Angabe `feature`. */
  kind?: 'feature' | 'bug';
  /** Herkunft aus GitHub: owner/repo#123. */
  externalRef?: string | null;
}

export type IdeaSource = 'human' | 'visionary' | 'routine' | 'production' | 'github';

/** Lauf des Visionärs (Ideen vorschlagen lassen). */
export interface VisionaryRun {
  id: string;
  status: 'requested' | 'running' | 'done' | 'failed' | 'cancelled';
  progress: string | null;
  createdCount: number;
  discardedCount: number;
  error: string | null;
  requestedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

/** Kompletter Test auf Knopfdruck (Dashboard): der Worker führt ihn aus und legt Bugs aus den Befunden an. */
export interface TestRequest {
  id: string;
  scope: 'full' | 'ui';
  status: 'requested' | 'running' | 'done' | 'failed';
  requestedBy: string | null;
  runId: string | null;
  bugCount: number;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface IdeaComment {
  id: string;
  ideationId: string;
  author: string;
  /** 'agent' = Antwort eines Agents (eigene Bubble-Farbe). */
  authorKind?: 'user' | 'agent';
  body: string;
  mentions?: { type: 'agent' | 'user'; id: string; name: string }[];
  replyTo?: string | null;
  /** Status der Agent-Anfrage, die dieser Kommentar ausgelöst hat (pending/processing = Agent arbeitet). */
  agentStatus?: string | null;
  createdAt: string;
}

export interface Attachment {
  id: string;
  ideationId: string | null;
  bugId?: string | null;
  filename: string;
  mime: string;
  size: number;
}

export interface DevelopmentItem extends Estimate {
  id: string;
  title: string;
  description: string;
  status: DevelopmentStatus;
  priority: Priority;
  sprintId: string | null;
  agentId?: string | null;
  /** express = Anfrage aus dem Dashboard-Chat, ungeplant im Sprint (entsteht und endet im Chat). */
  kind?: 'feature' | 'bug' | 'express';
  bugId?: string | null;
  ideationId?: string | null;
  testRunId?: string | null;
  completedAt?: string | null;
  risks?: string;
  retryCount?: number;
  failure?: string | null;
  failureBugId?: string | null;
  /** Aktion notwendig: in wenigen Worten, was ein Mensch tun muss (sonst leer). */
  actionTodo?: string | null;
  /** Review-Freigabe: Branch, seit wann er wartet, wann freigegeben. */
  reviewBranch?: string | null;
  reviewSince?: string | null;
  reviewApprovedAt?: string | null;
  /** Optische Freigabe im Reiter „Ansicht“: wann und von wem. */
  visualApprovedAt?: string | null;
  visualApprovedBy?: string | null;
  /** Vom Auftrag geänderte Dateien (gegenüber der Basis, nach jedem Agent-Schritt aktualisiert). */
  changedFiles?: string[];
  /** Folgeauftrag: bezieht sich auf diesen abgeschlossenen Auftrag. */
  followUpOf?: string | null;
  fixStatus?: string | null;
  /** Name des Sprints, aus dem der Auftrag herausgenommen wurde. */
  /** Reihenfolge im Sprint (Kanban). */
  sprintRank?: number | null;
  removedFromSprint?: string | null;
  removedFromSprintAt?: string | null;
  analysisStatus?: 'requested' | 'running' | 'done' | 'failed' | null;
  analysis?: string;
  projectContext?: string;
}

export interface Sprint {
  id: string;
  name: string;
  goal: string;
  status: SprintStatus;
  startDate: string | null;
  endDate: string | null;
  gitSync?: string | null;
  gitMessage?: string | null;
  gitCommit?: string | null;
  gitBranch?: string | null;
  gitSyncedAt?: string | null;
  /** PR-Modus: Link des Pull Requests und CI-Ampel. */
  prUrl?: string | null;
  ciStatus?: 'pending' | 'success' | 'failure' | null;
  /** Alle Aufträge durch: wartet auf das Go („Live schalten“). */
  reviewReadyAt?: string | null;
  /** Pausiert: laufende Agents beenden ihren Schritt, danach startet nichts Neues. */
  pausedAt?: string | null;
  pausedBy?: string | null;
}

export interface Bug {
  id: string;
  category?: Category | null;
  title: string;
  description: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  status: BugStatus;
  source: 'agent' | 'manual' | 'test' | 'github' | 'production' | 'routine';
  sprintId: string | null;
  fixNotes: string | null;
  createdAt: string;
  fixedAt: string | null;
  /** Herkunft aus GitHub: owner/repo#123. */
  externalRef?: string | null;
  /** Betriebs-Bug, der nach dem Beheben wieder auftrat. */
  regressedAt?: string | null;
  /** Freigabe für Agents (nur Bugs aus Betrieb oder GitHub): wann und von wem. */
  approvedAt?: string | null;
  approvedBy?: string | null;
  /** Betriebs-Bugs: Vorkommen der letzten 24 Stunden. */
  productionCount?: number | null;
}

/** Produktions-Rückkanal: Zustand fürs Dashboard und die Einstellungen. */
export interface ProductionStatus {
  healthUrl: string | null;
  configured: boolean;
  healthy: boolean;
  down: boolean;
  failures: number;
  lastError: string | null;
  checkedAt: string | null;
  downSince: string | null;
  logsConfigured: boolean;
  logsScannedAt: string | null;
  logError: string | null;
  /** Zuletzt vermerkte Lücke im Log-Scan (letzter erfolgreicher Scan zu lange her). */
  logGap: string | null;
  /** Gebündelte Log-Ereignisse (Fingerabdrücke) und ihre Vorkommen innerhalb der Aufbewahrung. */
  logEvents: number;
  logOccurrences: number;
  openBugs: number;
  criticalBugs: number;
  last24h: number;
}

export interface ProductionSnippets {
  endpoint: string;
  browser: string;
  node: string;
}

export interface DeploySuspect {
  deployedAt: string;
  orders: { id: string; title: string }[];
  sprints: { id: string; name: string }[];
}

export interface ProductionEvent {
  id: string;
  source: 'health' | 'logs' | 'ingest';
  origin: string;
  fingerprint: string;
  firstSeen: string;
  lastSeen: string;
  count: number;
  sample: string;
  deploySuspect: DeploySuspect | null;
}

/** Rollback-Vorschlag eines kritischen Betriebs-Bugs (Auswahl und Sperrgrund kommen vom Server). */
export interface RollbackProposal {
  fromTag: string | null;
  toTag: string | null;
  deployedAt: string | null;
  disabledReason: string | null;
  /** Migrationen, die der Zieltag nicht kennt; null = nicht prüfbar. */
  migrations: string[] | null;
}

/** Eintrag im Rollback-Protokoll (Bug-Verlauf). */
export interface RollbackEntry {
  id: string;
  bugId: string | null;
  fromTag: string;
  toTag: string;
  status: 'requested' | 'running' | 'succeeded' | 'failed';
  result: string | null;
  requestedBy: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

/** Link zum GitHub-Issue aus owner/repo#123 (null bei ungültigem Verweis). */
export function githubIssueLink(ref: string | null | undefined): { url: string; label: string } | null {
  const match = /^([A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100})#(\d{1,10})$/.exec(ref ?? '');
  return match ? { url: `https://github.com/${match[1]}/issues/${match[2]}`, label: `GitHub #${match[2]}` } : null;
}

export interface DocumentEntry {
  id: string;
  /**
   * test = Testberichte, settings = Agent-Einstellungen und Benutzerübersicht, workflow = Arbeitsweise von AIdeation
   * (alle erzeugt, schreibgeschützt).
   */
  kind: 'manual' | 'sprint' | 'order' | 'repo' | 'request' | 'test' | 'settings' | 'workflow';
  title: string;
  content: string;
  sprintId: string | null;
  developmentId?: string | null;
  updatedAt: string;
}

export interface DocRevision {
  id: string;
  docId: string;
  title: string;
  content: string;
  baseTitle: string;
  baseContent: string;
  note: string;
  status: 'pending' | 'approved' | 'rejected';
  authorId: string | null;
  authorName: string;
  reviewerName: string | null;
  reviewNote: string | null;
  reviewedAt: string | null;
  createdAt: string;
}

export interface Agent {
  id: string;
  name: string;
  role: string;
  phase: AgentPhase;
  position: number;
  instructions: string;
  enabled: boolean;
  command: string[] | null;
  /** Einzeln freigegebene Befehle des Agents (null = Projektstandard der Rolle). */
  allowedCommands?: string[] | null;
  /** Erlaubte Ordner für Dateirechte (leer = ganzes Projekt). */
  fileScope?: string[];
  /** Empfänger der Nachrichten dieses Agents (null = nächster Agent im Workflow). */
  handoffTo?: string | null;
}

/** Ein Einsatz im Workflow: welcher Agent bei welcher Phase an welcher Stelle läuft, mit eigener Anweisung. */
export interface WorkflowStep {
  id: string;
  phase: AgentPhase;
  position: number;
  agentId: string;
  instructions: string;
  enabled: boolean;
}

export interface StepEvent {
  at: string;
  text: string;
}

export interface RunStep {
  runId: string;
  agentId?: string | null;
  position: number;
  agentName?: string;
  command: string;
  status: string;
  exitCode?: number | null;
  durationMs?: number | null;
  output: string;
  progress?: string | null;
  events?: StepEvent[];
  tokens?: number | string | null;
  costUsd?: number | null;
  /** Verwendetes Modell (z. B. qwen3.5:9b oder claude (opus)) und die greifende Routing-Regel. */
  model?: string | null;
  routingRule?: string | null;
}

export interface AgentRun {
  id: string;
  developmentId?: string | null;
  title: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  steps: RunStep[];
}

export type TestCategory = 'quality' | 'unit' | 'e2e' | 'user';

export interface TestRun {
  id: string;
  status: string;
  trigger: string;
  branch: string | null;
  commitSha: string | null;
  /** Betriebssystem des Rechners (darwin, win32, linux). */
  platform?: string | null;
  startedAt: string;
  completedAt: string | null;
  steps: (RunStep & { category?: TestCategory })[];
  /** Einzeltests je Kategorie und Status, z. B. { unit: { passed: 140, failed: 2 } }. */
  summary?: Partial<Record<TestCategory, Partial<Record<TestCaseStatus, number>>>>;
  mediaCount?: number;
}

export type TestCaseStatus = 'passed' | 'failed' | 'skipped' | 'flaky';

export interface TestMedia {
  id: string;
  name: string;
  mime: 'image/png' | 'image/jpeg' | 'video/webm';
  size: number;
}

export interface TestCase {
  id: string;
  position: number;
  category: Exclude<TestCategory, 'quality'>;
  title: string;
  file: string | null;
  device: string | null;
  status: TestCaseStatus;
  durationMs: number | null;
  errors: string[];
  media: TestMedia[];
}

export interface SprintReport {
  sprintId: string;
  sprintName: string;
  sprintStatus: SprintStatus;
  summary: string;
  implemented: { id: string; title: string; kind: string; effortHours: number | null }[];
  missing: { id: string; title: string; status: string }[];
  problems: { type: string; title: string; detail: string }[];
  notes: string;
  generatedAt: string;
}

export interface ProjectStats {
  orders: Record<string, number>;
  ideas: Record<string, number>;
  bugs: Record<string, number>;
  openBugsBySeverity: Record<string, number>;
  effort: { plannedHours: number; doneHours: number; tokens: number };
  /** Tatsächlich von den Agents verbraucht (Laufzeit, Tokens, API-Kosten). */
  actual?: { tokens: number; hours: number; costUsd: number };
  testRuns: {
    total?: number;
    recent: { id: string; status: string; startedAt: string }[];
    passRate: number | null;
  };
  agents: { agent: string; passed: number; failed: number; skipped: number }[];
  sprint: {
    id: string;
    name: string;
    total: number;
    done: number;
    percent: number;
    burndown: { day: string; remaining: number }[];
  } | null;
  velocity: {
    id?: string;
    name: string;
    status: string;
    total: number;
    done: number;
    hours: number;
    /** Trefferquote der Schätzung: Treffer von gemessenen erledigten Aufträgen (percent null = keine gemessen). */
    hitRate?: { hits: number; measured: number; percent: number | null };
    /** Schätzfehler: Median Ist ÷ Schätzung der erledigten Aufträge; null ohne erledigte, gemessene Aufträge. */
    hourError?: number | null;
    tokenError?: number | null;
    errorSamples?: number;
  }[];
  /** Korrekturfaktor je Herkunft der Schätzung (Median Ist ÷ Schätzung) und Anzahl der Messwerte. */
  calibration?: {
    source: string;
    label: string;
    hours: number;
    tokens: number;
    samples: number;
    scope: 'project' | 'all' | 'default';
  }[];
  /** Laufende Aufträge über dem Dreifachen ihrer kalibrierten Schätzung (Stunden oder Tokens). */
  overruns?: EstimateOverrun[];
}

export interface EstimateOverrun {
  id: string;
  title: string;
  status: string;
  actual: { hours: number; tokens: number };
  calibrated: { hours: number | null; tokens: number | null };
  ratio: { hours: number | null; tokens: number | null };
  exceeded: { hours: boolean; tokens: boolean };
  scope: string;
}

export interface DraftOrder {
  id: string;
  title: string;
  status: 'requested' | 'drafting';
  progress: string | null;
  agent: string | null;
  startedAt: string | null;
}

/** Git-Zustand der Projektordner, vom Worker jede Minute erfasst (siehe src/runner/repo-state.ts). */
export type GitFix = 'save_wip' | 'checkout_main' | 'sync_main';
export type GuardedAction = 'go_live' | 'approve' | 'sprint_start';

export interface GitProblem {
  code: 'foreign_branch' | 'uncommitted' | 'untracked' | 'main_diverged' | 'main_ahead' | 'main_behind';
  role: 'live' | 'agents';
  folder: string;
  severity: 'block' | 'warn';
  title: string;
  detail: string;
  fixes: GitFix[];
}

export interface GitFolder {
  folder: string;
  role: 'live' | 'agents';
  branch: string | null;
  repository: boolean;
}

export interface GitStatus {
  state: { checkedAt: string; folders: GitFolder[]; problems: GitProblem[] } | null;
  stateAt: string | null;
  /** Älter als 5 Minuten (Worker aus): dann wird nichts gesperrt. */
  stale: boolean;
  fix: {
    id: string;
    fix: GitFix;
    role: 'live' | 'agents';
    status: 'requested' | 'running' | 'done' | 'failed';
    message: string | null;
    createdAt: string;
    finishedAt: string | null;
  } | null;
}

export interface WorkerStatus {
  online: boolean;
  git?: GitStatus;
  worker: { lastError: string | null; intervalSeconds: number; cpuPercent: number | null } | null;
  running: { title: string; startedAt: string }[];
  /** Aufträge in Entstehung: Ideen, aus denen der Auftragsautor gerade einen Auftrag schreibt. */
  drafts?: DraftOrder[];
  agents: {
    id: string;
    name: string;
    role?: string;
    active: boolean;
    /** Wartet auf eine Antwort (Rückfrage des Dashboard-Assistenten) oder auf den Start einer Chat-Anfrage. */
    waiting?: boolean;
    /** Arbeitet an einer Chat-Anfrage oder Agent-Aufgabe statt an einem Auftrag (kein „Abbrechen“). */
    manual?: boolean;
    sprintName: string | null;
    orderTitle: string | null;
  }[];
}

export interface AgentStatus {
  maxConcurrentAgents: number;
  projects: { slug: string; name: string; online: boolean; lastError: string | null }[];
  running: { project: string; title: string; startedAt: string }[];
}

export interface UpcomingTask {
  id: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  sprintName: string | null;
}

export interface AgentActivity {
  id: number;
  stepStatus: string;
  durationMs: number | null;
  output: string;
  progress?: string | null;
  events?: StepEvent[];
  startedAt: string;
  orderId: string;
  orderTitle: string;
  orderDescription: string;
  orderStatus: string;
  orderPriority: string;
  sprintId: string | null;
  sprintName: string | null;
  sprintGoal: string | null;
  sprintStatus: string | null;
  sprintStart: string | null;
  sprintEnd: string | null;
}

/** Je Bereichsschlüssel der neueste vollständige Lauf (ohne vollständigen Lauf: Prozentwerte null). */
export interface CoverageArea {
  area: CoverageAreaKey;
  unit: number;
  component: number;
  integration: number;
  e2e: number;
  passed: number;
  failed: number;
  lines: number | null;
  statements: number | null;
  branches: number | null;
  functions: number | null;
  /** Datum des Laufs, aus dem die Zeile stammt. */
  createdAt: string;
  complete: boolean;
}

/** Zeilenabdeckung eines vollständigen Laufs für den Verlauf je Bereich. */
export interface CoverageHistoryPoint {
  area: CoverageAreaKey;
  lines: number;
  createdAt: string;
}

/** Letzter Abdeckungsbericht des Testers mit der Übersicht je Bereich und dem Verlauf. */
export interface CoverageReport {
  id: string;
  summary: string;
  createdAt: string;
  developmentId: string | null;
  orderTitle: string | null;
  areas: CoverageArea[];
  history: CoverageHistoryPoint[];
}

/** Ein Bericht in der Zeitreihe eines Bereichs; null = im Altbestand nicht gemeldet (Lücke, nicht 0 %). */
export interface CoverageTrendPoint {
  reportId: string;
  date: string;
  lines: number | null;
  branches: number | null;
  tests: number;
}

/** Zeitreihe je fester Bereich (COVERAGE_AREA_KEYS), nach Datum aufsteigend. */
export interface CoverageTrend {
  areas: { area: CoverageAreaKey; points: CoverageTrendPoint[] }[];
}

export interface AcceptanceCheck {
  developmentId: string;
  /** visual = Befund der visuellen Prüfung (Screenshots, Browser-Prüfungen, KI-Urteil). */
  kind: 'criterion' | 'done' | 'visual';
  position: number;
  text: string;
  /** verifying = Agent-Prüfung angefragt, checking = Agent prüft gerade. */
  status: 'open' | 'met' | 'unmet' | 'manual' | 'verifying' | 'checking';
  note: string | null;
  checkedAt: string | null;
}

/** Offener Testnachweis (@@NACHWEIS von Tester bzw. Dokumentierer): ein Befehl, den ein Mensch als Testlauf startet. */
export interface TestEvidence {
  id: string;
  developmentId: string;
  position: number;
  datei: string;
  befehl: string;
  /** nicht_freigegeben = Befehl für den Agent gesperrt, gegenprobe_fehlt = Lauf steht noch aus. */
  grund: 'nicht_freigegeben' | 'gegenprobe_fehlt';
  status: 'open' | 'passed' | 'failed' | 'nicht_freigegeben';
  agentName: string | null;
  runId: string | null;
  checkedAt: string | null;
  /** Lässt die Befehlsprüfung (isAllowedCommand) den Befehl zu? Sonst nur der Verweis auf die Rechte. */
  allowed: boolean;
  /** Ein Testlauf für diesen Nachweis ist angefordert oder läuft. */
  running: boolean;
}

export interface AcceptanceDefaults {
  definitionOfReady: string[];
  definitionOfDone: string[];
}

export interface ProjectData {
  comments: IdeaComment[];
  ideas: Idea[];
  attachments: Attachment[];
  development: DevelopmentItem[];
  sprints: Sprint[];
  agents: Agent[];
  agentRuns: AgentRun[];
  runs: TestRun[];
  stats: ProjectStats | null;
  bugs: Bug[];
  docs: DocumentEntry[];
  reports: SprintReport[];
  coverage: CoverageReport | null;
  acceptance: AcceptanceCheck[];
  acceptanceDefaults: AcceptanceDefaults | null;
  docRevisions: DocRevision[];
  /** Offene (nicht abgehakte) Testnachweise. */
  evidence: TestEvidence[];
  /** Ein kompletter Test (bzw. Nachweis-Lauf) des Projekts ist angefordert oder läuft. */
  testRunning: boolean;
}

export const emptyProjectData = (): ProjectData => ({
  comments: [],
  ideas: [],
  attachments: [],
  development: [],
  sprints: [],
  agents: [],
  agentRuns: [],
  runs: [],
  stats: null,
  bugs: [],
  docs: [],
  reports: [],
  coverage: null,
  acceptance: [],
  acceptanceDefaults: null,
  docRevisions: [],
  evidence: [],
  testRunning: false,
});

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  status: 'pending' | 'processing' | 'done' | 'failed';
  /** Aktionen des Assistenten (Lesen, Schreiben, Ausführen) – dieselbe Form wie bei Agent-Schritten. */
  events?: StepEvent[];
  /** Rückfrage des Assistenten, auf die er eine Antwort erwartet. */
  question?: string | null;
  /** Agent, der die Anfrage übernimmt bzw. beantwortet hat (leer = allgemeiner Assistent). */
  agentId?: string | null;
  agentName?: string | null;
  /** Verweise der Nachricht (/auftrag/…, /git/…, @Person), vom Server geprüft. */
  references?: { type: string; id: string; label: string }[];
  createdAt: string;
  /** Antwortmöglichkeiten zur Rückfrage (zum Anklicken). */
  questionOptions?: string[];
  /** Rückfrage schon beantwortet. */
  answered?: boolean;
  /** Antwort auf diese Rückfrage. */
  replyTo?: string | null;
}

/** Review-Container (projektübergreifend geteilt): was er gerade zeigt und unter welcher Adresse. */
export interface ReviewSlot {
  slot: number;
  enabled: boolean;
  url: string;
  status: 'idle' | 'requested' | 'starting' | 'running' | 'failed' | 'stopping';
  message: string | null;
  projectSlug: string | null;
  label: string | null;
  commit: string | null;
  developmentId: string | null;
  kind: 'manual' | 'approval' | null;
  startedAt: string | null;
}

/** Review-Freigabe eines Projekts: Einstellung, Review-Container und wartende Aufträge. */
export interface ReviewState {
  mode: 'off' | 'ui' | 'always';
  configured: boolean;
  slots: ReviewSlot[];
  waiting: { id: string; title: string; reviewSince: string | null; reviewApprovedAt: string | null }[];
}

/** Startbarer Stand eines Sprints (gemergter Auftrag oder offener Auftrags-Branch). */
export interface SprintCommit {
  hash: string;
  subject: string;
  date: string;
  developmentId: string | null;
  merged: boolean;
}

/** Startbarer Stand für die Kopfzeile (GET /projects/:slug/review-commits): mit Auftragsname und Sprint. */
export interface ReviewCommit extends SprintCommit {
  title: string;
  orderStatus: string | null;
  sprintId: string;
  sprintName: string;
  sprintStatus: string;
}

export interface BudgetLimit {
  maxTokens: number | null;
  maxCostUsd: number | null;
}

export interface BudgetStatus {
  period: BudgetPeriod;
  spend: { tokens: number; costUsd: number };
  limit: BudgetLimit & { period: BudgetPeriod };
  percent: number;
}

/** Budget eines Projekts: Limits, Anzeigewährung, Stand (Tag/Sprint) und Modell-Routing. */
export interface BudgetOverview {
  limits: Record<BudgetPeriod, BudgetLimit>;
  currency: 'USD' | 'CHF';
  chfPerUsd: number;
  warnPercent: number;
  status: BudgetStatus[];
  routing: {
    rules: RoutingRule[];
    customized: boolean;
    defaults: RoutingRule[];
    localModel: string | null;
    strongCommand: string[] | null;
  };
  ollamaModels: string[];
}

/** Nutzungslimit eines Agent-Anbieters (GET /agent-limits); die Aktionen gibt der Server je Benutzer frei. */
export interface ProviderLimit {
  provider: string;
  label: string;
  status: 'ok' | 'limited';
  since: string | null;
  resetAt: string | null;
  /** „org“: Limit der Organisation, erhöhen kann es nur ein Admin dort. */
  scope?: 'account' | 'org';
  paymentUrl: string;
  actions: { pay: boolean; resume: boolean };
}
