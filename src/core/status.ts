export const IDEATION_STATUS = {
  idea: 'idea',
  considering: 'considering',
  review: 'review',
  requested: 'requested',
  drafting: 'drafting',
  accepted: 'accepted',
  rejected: 'rejected',
} as const;
/** Abgeschlossene Ideen: alle anderen (auch ohne Status) gelten als offen. */
export const CLOSED_IDEATION_STATUSES: readonly string[] = [IDEATION_STATUS.accepted, IDEATION_STATUS.rejected];
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
/** Abgeschlossene Aufträge: alle anderen (auch ohne Status) gelten als offen. */
export const CLOSED_DEVELOPMENT_STATUSES: readonly string[] = [DEVELOPMENT_STATUS.done, DEVELOPMENT_STATUS.rejected];

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

export const SPRINT_STATUS = {
  planned: 'planned',
  active: 'active',
  review: 'review',
  completed: 'completed',
  cancelled: 'cancelled',
} as const;
export type SprintStatus = (typeof SPRINT_STATUS)[keyof typeof SPRINT_STATUS];

export const RUN_STATUS = {
  running: 'running',
  passed: 'passed',
  failed: 'failed',
} as const;
export type RunStatus = (typeof RUN_STATUS)[keyof typeof RUN_STATUS];
export const TEST_RUN_STATUS = RUN_STATUS;

export const AGENT_RUN_STATUS = RUN_STATUS;

export const AGENT_STEP_STATUS = {
  running: 'running',
  passed: 'passed',
  failed: 'failed',
  skipped: 'skipped',
} as const;
export type AgentStepStatus = (typeof AGENT_STEP_STATUS)[keyof typeof AGENT_STEP_STATUS];

/** Review-Freigabe je Projekt: nie, nur bei Änderungen an der Oberfläche, immer. */
export const REVIEW_MODES = new Set<string>(['off', 'ui', 'always']);
