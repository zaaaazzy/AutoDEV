export type Priority = 'low' | 'medium' | 'high';
export type SprintStatus = 'planned' | 'active' | 'completed';
export type DevelopmentStatus = 'backlog' | 'planned' | 'in_progress' | 'blocked' | 'done' | 'rejected';
export type BugStatus = 'open' | 'in_progress' | 'fixed' | 'wontfix' | 'rejected';
export type AgentPhase = 'pre_task' | 'while_task' | 'after_task';

export interface Project {
  slug: string;
  name: string;
  repository: string;
  gitRemote?: string | null;
  testCommands?: string[][];
  deployCommands?: string[][] | null;
  deployStatus?: string | null;
  description?: string;
  guidelines?: string;
  autoBugfix?: boolean;
  /** Sprintplanung: manuell (Standard), vorschlagen oder Autopilot. */
  sprintMode?: 'manual' | 'suggest' | 'autopilot';
  /** Kapazität eines Sprints in Stunden, solange es keine abgeschlossenen Sprints gibt. */
  sprintCapacityHours?: number;
  /** Arbeitszeiten des Sprint-Autopilots (HH:MM, Wochentage 1 = Montag … 7 = Sonntag). */
  autopilotStart?: string;
  autopilotEnd?: string;
  autopilotDays?: number[];
  databaseConfigured?: boolean;
  definitionOfReady?: string[] | null;
  definitionOfDone?: string[] | null;
  /** Stand des Favicons der Anwendung (null = keines gefunden). */
  faviconVersion?: number | null;
  /** Produktions-Rückkanal: Health-URL, Compose-Dienste, Ausschlussmuster, Aufbewahrung, Ingest-Token hinterlegt. */
  healthUrl?: string | null;
  logServices?: string[];
  productionIgnore?: string[];
  productionRetentionDays?: number;
  ingestConfigured?: boolean;
}

export type Category = 'frontend' | 'backend' | 'fullstack' | 'infrastructure' | 'docs';

export interface Estimate {
  /** Bereich der Arbeit; Aufträge erben ihn von Idee bzw. Bug. */
  category?: Category | null;
  effortHours?: number | null;
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
  kind?: 'feature' | 'bug';
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
}

export interface Bug {
  id: string;
  category?: Category | null;
  title: string;
  description: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  status: BugStatus;
  source: 'agent' | 'manual' | 'test' | 'production';
  sprintId: string | null;
  fixNotes: string | null;
  createdAt: string;
  fixedAt: string | null;
  /** Betriebs-Bug, der nach dem Beheben wieder auftrat. */
  regressedAt?: string | null;
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
  logsScannedAt: string | null;
  logError: string | null;
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

export interface DocumentEntry {
  id: string;
  /** test = Testberichte, settings = Agent-Einstellungen und Benutzerübersicht (beide erzeugt, schreibgeschützt). */
  kind: 'manual' | 'sprint' | 'order' | 'repo' | 'request' | 'test' | 'settings';
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
  velocity: { name: string; status: string; total: number; done: number; hours: number }[];
}

export interface DraftOrder {
  id: string;
  title: string;
  status: 'requested' | 'drafting';
  progress: string | null;
  agent: string | null;
  startedAt: string | null;
}

export interface WorkerStatus {
  online: boolean;
  worker: { lastError: string | null; intervalSeconds: number; cpuPercent: number | null } | null;
  running: { title: string; startedAt: string }[];
  /** Aufträge in Entstehung: Ideen, aus denen der Auftragsautor gerade einen Auftrag schreibt. */
  drafts?: DraftOrder[];
  agents: {
    id: string;
    name: string;
    role?: string;
    active: boolean;
    /** Wartet auf eine Antwort (Rückfrage des Dashboard-Assistenten). */
    waiting?: boolean;
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

export interface CoverageArea {
  area: string;
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
}

/** Letzter Abdeckungsbericht des Testers. */
export interface CoverageReport {
  id: string;
  summary: string;
  createdAt: string;
  developmentId: string | null;
  orderTitle: string | null;
  areas: CoverageArea[];
}

export interface AcceptanceCheck {
  developmentId: string;
  kind: 'criterion' | 'done';
  position: number;
  text: string;
  /** verifying = Agent-Prüfung angefragt, checking = Agent prüft gerade. */
  status: 'open' | 'met' | 'unmet' | 'manual' | 'verifying' | 'checking';
  note: string | null;
  checkedAt: string | null;
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
}
