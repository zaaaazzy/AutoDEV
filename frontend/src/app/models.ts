export type Priority = 'low' | 'medium' | 'high';
export type SprintStatus = 'planned' | 'active' | 'completed';
export type DevelopmentStatus = 'backlog' | 'planned' | 'in_progress' | 'blocked' | 'done';
export type BugStatus = 'open' | 'in_progress' | 'fixed' | 'wontfix';
export type AgentPhase = 'pre_task' | 'while_task' | 'after_task';

export interface Project {
  slug: string;
  name: string;
  repository: string;
  gitRemote?: string | null;
  testCommands?: string[][];
  description?: string;
  guidelines?: string;
}

export interface Estimate {
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
}

export interface IdeaComment {
  id: string;
  ideationId: string;
  author: string;
  body: string;
  createdAt: string;
}

export interface Attachment {
  id: string;
  ideationId: string;
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
  title: string;
  description: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  status: BugStatus;
  source: 'agent' | 'manual';
  sprintId: string | null;
  fixNotes: string | null;
  createdAt: string;
  fixedAt: string | null;
}

export interface DocumentEntry {
  id: string;
  kind: 'manual' | 'sprint' | 'order' | 'repo';
  title: string;
  content: string;
  sprintId: string | null;
  updatedAt: string;
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
}

export interface RunStep {
  position: number;
  agentName?: string;
  command: string;
  status: string;
  exitCode?: number | null;
  durationMs?: number | null;
  output: string;
  progress?: string | null;
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

export interface TestRun {
  id: string;
  status: string;
  trigger: string;
  branch: string | null;
  commitSha: string | null;
  startedAt: string;
  completedAt: string | null;
  steps: RunStep[];
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
  testRuns: { recent: { id: string; status: string; startedAt: string }[]; passRate: number | null };
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

export interface WorkerStatus {
  online: boolean;
  worker: { lastError: string | null; intervalSeconds: number; cpuPercent: number | null } | null;
  running: { title: string; startedAt: string }[];
  agents: { id: string; name: string; active: boolean; sprintName: string | null; orderTitle: string | null }[];
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
});

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  status: 'pending' | 'processing' | 'done' | 'failed';
  createdAt: string;
  developmentId?: string | null;
  developmentTitle?: string | null;
  developmentStatus?: string | null;
  agentName?: string | null;
}
