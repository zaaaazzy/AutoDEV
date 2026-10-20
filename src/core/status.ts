export const IDEATION_STATUS = {
  idea: 'idea',
  considering: 'considering',
  review: 'review',
  requested: 'requested',
  drafting: 'drafting',
  accepted: 'accepted',
  rejected: 'rejected',
} as const;
export type IdeationStatus = (typeof IDEATION_STATUS)[keyof typeof IDEATION_STATUS];
export const EDITABLE_IDEATION_STATUSES = new Set<string>([
  IDEATION_STATUS.idea,
  IDEATION_STATUS.considering,
  IDEATION_STATUS.review,
]);

export const DEVELOPMENT_STATUS = {
  backlog: 'backlog',
  planned: 'planned',
  inProgress: 'in_progress',
  blocked: 'blocked',
  /** Fertig und getestet, wartet auf die Freigabe (Review-Instanz); erst dann wird gemergt. */
  approval: 'approval',
  done: 'done',
  /** Verstösst gegen die Projektregeln (Do's and Don'ts): wird nicht umgesetzt. */
  rejected: 'rejected',
} as const;
export type DevelopmentStatus = (typeof DEVELOPMENT_STATUS)[keyof typeof DEVELOPMENT_STATUS];
export const DEVELOPMENT_STATUSES = new Set<string>(Object.values(DEVELOPMENT_STATUS));

export const BUG_STATUS = {
  open: 'open',
  inProgress: 'in_progress',
  fixed: 'fixed',
  wontfix: 'wontfix',
  /** Behebung verstösst gegen die Projektregeln. */
  rejected: 'rejected',
} as const;
export type BugStatus = (typeof BUG_STATUS)[keyof typeof BUG_STATUS];
export const BUG_STATUSES = new Set<string>(Object.values(BUG_STATUS));

export const RUN_STATUS = {
  running: 'running',
  passed: 'passed',
  failed: 'failed',
} as const;
export type RunStatus = (typeof RUN_STATUS)[keyof typeof RUN_STATUS];
export const TEST_RUN_STATUS = RUN_STATUS;
export type TestRunStatus = RunStatus;

export const AGENT_RUN_STATUS = RUN_STATUS;
export type AgentRunStatus = RunStatus;

export const AGENT_STEP_STATUS = {
  running: 'running',
  passed: 'passed',
  failed: 'failed',
  skipped: 'skipped',
} as const;
export type AgentStepStatus = (typeof AGENT_STEP_STATUS)[keyof typeof AGENT_STEP_STATUS];

/** Review-Freigabe je Projekt: nie, nur bei Änderungen an der Oberfläche, immer. */
export const REVIEW_MODES = new Set<string>(['off', 'ui', 'always']);
