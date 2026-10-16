import type { Pool } from 'pg';
import type { CommandExecutor, CommandResult } from '../core/command.js';
import type { KnownBug } from '../api/bugs.js';
import type { AgentStepStatus } from '../core/status.js';

export interface WorkItem {
  id: string;
  projectSlug: string;
  title: string;
  description: string;
  kind?: string;
  bugId?: string | null;
  sprintId?: string | null;
  ideationId?: string | null;
  agentId?: string | null;
  risks?: string;
}

export interface PromptExtras {
  bugs?: KnownBug[];
  manual?: string;
  images?: string[];
}

/** Runs an agent that has no command of its own (built-in tester or local model). */
export type BuiltinAgent = (context: {
  pool: Pool;
  item: WorkItem;
  agent: WorkflowAgent;
  prompt: string;
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Meldet jede Aktion des Agents (z. B. Dateizugriff) für die Live-Ausgabe. */
  onProgress?: (message: string) => void;
}) => Promise<CommandResult>;

export interface WorkflowAgent {
  id: string;
  name: string;
  role: string;
  phase: string;
  position: number;
  instructions: string;
  command: string[] | null;
}

export interface StepSummary {
  agentName: string;
  phase: string;
  status: Extract<AgentStepStatus, 'passed' | 'failed'>;
  output: string;
}

export interface RunnerOptions {
  project: string;
  cwd: string;
  itemId?: string;
  limit: number;
  timeoutMs: number;
  watch: boolean;
  intervalMs: number;
  all?: boolean;
}

export interface WorkItemOptions {
  cwd: string;
  timeoutMs: number;
  execute?: CommandExecutor;
  builtin?: BuiltinAgent;
}
