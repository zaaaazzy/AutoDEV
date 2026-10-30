import type { ProjectTable } from './tenancy.js';

/**
 * Allowlist der ID-Felder: jede API-Route, die eine ID aus Pfad oder Body übernimmt, die zu einem anderen Projekt
 * gehören könnte. Den Mandanten der Route selbst (:slug bei tenant 'project', :id bei einem Datensatz-Mandanten) prüft
 * schon routeGuard (access.ts); hier stehen alle weiteren IDs. Jede Route prüft sie mit assertInProject (tenancy.ts)
 * oder einer gleichwertigen Abfrage, bevor sie schreibt.
 *
 * tenant-ids.test.ts liest die registrierten Express-Routen und ihren Quelltext und scheitert, wenn eine Route mit
 * ID-Feld hier fehlt. Für jeden Eintrag schickt er eine gültige ID aus dem Projekt „fremd“ (erwartet `refused`, die
 * Datenbank bleibt unverändert) und eine aus dem eigenen Projekt (bisheriger Erfolgsstatus).
 */
export interface TenantIdField {
  method: Method;
  /** Pfad wie registriert (ohne /api). */
  path: string;
  in: 'path' | 'body';
  field: string;
  /** Tabelle, zu der die ID gehört. */
  table: ProjectTable;
  /** Antwort bei einer ID aus einem anderen Projekt: 400 (falsche Eingabe) oder 404 (nicht gefunden). */
  refused: 400 | 404;
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

const body = (method: Method, path: string, field: string, table: ProjectTable, refused: 400 | 404 = 400) =>
  ({ method, path, in: 'body', field, table, refused }) as const;
const inPath = (method: Method, path: string, field: string, table: ProjectTable, refused: 400 | 404 = 404) =>
  ({ method, path, in: 'path', field, table, refused }) as const;

export const TENANT_ID_FIELDS: readonly TenantIdField[] = [
  // agent-tasks.ts
  body('POST', '/projects/:slug/agent-tasks', 'agentId', 'agents'),
  body('PATCH', '/agent-tasks/:id', 'agentId', 'agents'),
  // agents.ts
  body('POST', '/projects/:slug/agents', 'handoffTo', 'agents'),
  body('POST', '/projects/:slug/agents/order', 'ids', 'agents'),
  body('PATCH', '/agents/:id', 'handoffTo', 'agents'),
  // worker.ts
  inPath('GET', '/projects/:slug/agents/:id/activity', 'id', 'agents'),
  inPath('POST', '/projects/:slug/agents/:id/cancel', 'id', 'agents'),
  // bugs.ts
  body('POST', '/projects/:slug/bugs', 'sprintId', 'sprints'),
  body('PATCH', '/bugs/:id', 'sprintId', 'sprints'),
  // chat-routes.ts; references verweist auf Aufträge, Ideen, Bugs, Sprints oder Dokumente (resolveReferences)
  body('POST', '/projects/:slug/chat', 'agentId', 'agents'),
  body('POST', '/projects/:slug/chat', 'replyTo', 'chat_messages'),
  body('POST', '/projects/:slug/chat', 'references', 'development_items'),
  // development.ts
  body('POST', '/projects/:slug/development', 'ideationId', 'ideation_items'),
  body('POST', '/projects/:slug/development', 'testRunId', 'test_runs'),
  body('POST', '/projects/:slug/development', 'sprintId', 'sprints'),
  body('POST', '/projects/:slug/development', 'agentId', 'agents'),
  body('POST', '/development/:id/follow-up', 'sprintId', 'sprints'),
  body('POST', '/development/:id/retry', 'sprintId', 'sprints'),
  body('POST', '/development/:id/take-into-sprint', 'sprintId', 'sprints'),
  body('PATCH', '/development/:id', 'sprintId', 'sprints'),
  body('PATCH', '/development/:id', 'agentId', 'agents'),
  // test-runs.ts
  inPath('GET', '/projects/:slug/test-runs/:id/cases', 'id', 'test_runs'),
  // permission-groups.ts (ID je Projekt, Schlüssel project_slug + id)
  inPath('PATCH', '/projects/:slug/permission-groups/:id', 'id', 'project_permission_groups'),
  inPath('DELETE', '/projects/:slug/permission-groups/:id', 'id', 'project_permission_groups'),
  // review-routes.ts (Fehlercode bleibt 404)
  body('POST', '/projects/:slug/review-slots/start', 'developmentId', 'development_items', 404),
  // workflow.ts
  body('POST', '/projects/:slug/workflow/steps', 'agentId', 'agents'),
  body('POST', '/projects/:slug/workflow/order', 'ids', 'workflow_steps'),
  // sprints.ts
  body('POST', '/sprints/:id/order', 'ids', 'development_items'),
  // sprint-planning.ts (nur Aufträge aus dem Vorschlag des eigenen Projekts)
  body('POST', '/projects/:slug/sprints/proposal/apply', 'ids', 'development_items'),
  body('POST', '/projects/:slug/sprints/proposal/comment', 'ids', 'development_items'),
];

/** Pfadparameter, die wie ein ID-Feld aussehen, aber keinen Datensatz eines Projekts bezeichnen. */
export const TENANT_ID_EXEMPT: readonly { method: Method; path: string; field: string; reason: string }[] = [
  {
    method: 'PUT',
    path: '/projects/:slug/budget/roles/:role',
    field: 'role',
    reason: 'Name einer Agent-Rolle aus fester Liste, kein Datensatz.',
  },
  {
    method: 'POST',
    path: '/review-slots/:slot/stop',
    field: 'slot',
    reason: 'Nummer eines geteilten Review-Containers (1–9), kein Datensatz eines Projekts.',
  },
];
