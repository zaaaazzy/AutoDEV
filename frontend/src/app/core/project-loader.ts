import type { ApiService } from './api.service.js';
import { errorMessage } from './errors.js';
import {
  emptyProjectData,
  type AcceptanceCheck,
  type AcceptanceDefaults,
  type DocRevision,
  type Agent,
  type Attachment,
  CoverageReport,
  type Bug,
  type DevelopmentItem,
  type DocumentEntry,
  type Idea,
  type IdeaComment,
  type ProjectData,
  type ProjectStats,
  type Sprint,
  type SprintReport,
  type TestRun,
} from './models.js';

export interface LoadedProject {
  data: ProjectData;
  errors: Record<string, string>;
  /** Felder, deren Ressource nicht geladen werden konnte (auch ohne Meldung in `errors`). */
  failed: (keyof ProjectData)[];
}

/** Lädt alle Ressourcen eines Projekts; fehlgeschlagene Ressourcen bleiben leer und landen in `errors`. */
export async function fetchProjectData(api: ApiService, slug: string): Promise<LoadedProject> {
  const base = api.projectPath(slug);
  const results = await Promise.allSettled([
    api.get<{ ideas?: Idea[]; development?: DevelopmentItem[]; comments?: IdeaComment[] }>(`${base}/board`),
    api.get<{ sprints?: Sprint[] }>(`${base}/sprints`),
    api.get<{ agents?: Agent[] }>(`${base}/agents`),
    api.get<{ runs?: ProjectData['agentRuns'] }>(`${base}/agent-runs`),
    api.get<{ runs?: TestRun[] }>(`${base}/test-runs`),
    api.get<ProjectStats>(`${base}/stats`),
    api.get<{ bugs?: Bug[] }>(`${base}/bugs`),
    api.get<{ docs?: DocumentEntry[] }>(`${base}/docs`),
    api.get<{ reports?: SprintReport[] }>(`${base}/sprint-reports`),
    api.get<{ attachments?: Attachment[] }>(`${base}/attachments`),
    api.get<{ report?: CoverageReport | null }>(`${base}/coverage`),
    api.get<{ checks?: AcceptanceCheck[]; defaults?: AcceptanceDefaults }>(`${base}/acceptance`),
    api.get<{ revisions?: DocRevision[] }>(`${base}/doc-revisions`),
  ]);

  const data = emptyProjectData();
  const errors: Record<string, string> = {};
  const failed: (keyof ProjectData)[] = [];
  const [
    board,
    sprints,
    agents,
    agentRuns,
    runs,
    stats,
    bugs,
    docs,
    reports,
    attachments,
    coverage,
    acceptance,
    revisions,
  ] = results;
  if (revisions.status === 'fulfilled') data.docRevisions = revisions.value.revisions ?? [];
  else failed.push('docRevisions');
  if (acceptance.status === 'fulfilled') {
    data.acceptance = acceptance.value.checks ?? [];
    data.acceptanceDefaults = acceptance.value.defaults ?? null;
  } else failed.push('acceptance', 'acceptanceDefaults');
  if (coverage.status === 'fulfilled') data.coverage = coverage.value.report ?? null;
  else failed.push('coverage');
  if (attachments.status === 'fulfilled') data.attachments = attachments.value.attachments ?? [];
  else errors.attachments = errorMessage(attachments.reason, 'Bilder konnten nicht geladen werden.');
  if (board.status === 'fulfilled') {
    data.ideas = board.value.ideas ?? [];
    data.development = board.value.development ?? [];
    data.comments = board.value.comments ?? [];
  } else errors.board = errorMessage(board.reason, 'Entwicklungsboard konnte nicht geladen werden.');
  if (sprints.status === 'fulfilled') data.sprints = sprints.value.sprints ?? [];
  else errors.sprints = errorMessage(sprints.reason, 'Sprints konnten nicht geladen werden.');
  if (agents.status === 'fulfilled') data.agents = agents.value.agents ?? [];
  else errors.agents = errorMessage(agents.reason, 'Agents konnten nicht geladen werden.');
  if (agentRuns.status === 'fulfilled') data.agentRuns = agentRuns.value.runs ?? [];
  else errors.agentRuns = errorMessage(agentRuns.reason, 'Agent-Läufe konnten nicht geladen werden.');
  if (runs.status === 'fulfilled') data.runs = runs.value.runs ?? [];
  else errors.runs = errorMessage(runs.reason, 'Testläufe konnten nicht geladen werden.');
  if (stats.status === 'fulfilled') data.stats = stats.value;
  else errors.stats = errorMessage(stats.reason, 'Statistiken konnten nicht geladen werden.');
  if (bugs.status === 'fulfilled') data.bugs = bugs.value.bugs ?? [];
  else errors.bugs = errorMessage(bugs.reason, 'Bugs konnten nicht geladen werden.');
  if (docs.status === 'fulfilled') data.docs = docs.value.docs ?? [];
  else errors.docs = errorMessage(docs.reason, 'Dokumente konnten nicht geladen werden.');
  if (reports.status === 'fulfilled') data.reports = reports.value.reports ?? [];
  else errors.reports = errorMessage(reports.reason, 'Sprintberichte konnten nicht geladen werden.');

  for (const [key, fields] of Object.entries(ERROR_FIELDS)) if (errors[key]) failed.push(...fields);

  // Ohne geladene Bugs lässt sich nicht erkennen, welche Bugfix-Aufträge verwaist sind – dann nichts ausblenden.
  return { data: errors.bugs ? data : withoutOrphanedBugOrders(data), errors, failed };
}

/** Welche Datenfelder zu einem Eintrag in `errors` gehören. */
const ERROR_FIELDS: Record<string, (keyof ProjectData)[]> = {
  attachments: ['attachments'],
  board: ['ideas', 'development', 'comments'],
  sprints: ['sprints'],
  agents: ['agents'],
  agentRuns: ['agentRuns'],
  runs: ['runs'],
  stats: ['stats'],
  bugs: ['bugs'],
  docs: ['docs'],
  reports: ['reports'],
};

/**
 * Für das Nachladen im Hintergrund: Bereiche, die diesmal nicht geladen werden konnten,
 * behalten ihren bisherigen Stand statt still leer zu werden.
 */
export function keepFailedSections(previous: ProjectData, loaded: LoadedProject): ProjectData {
  const data = { ...loaded.data };
  for (const field of loaded.failed) (data as Record<string, unknown>)[field] = previous[field];
  return data;
}

function withoutOrphanedBugOrders(data: ProjectData): ProjectData {
  const bugIds = new Set(data.bugs.map((bug) => bug.id));
  const development = data.development.filter((item) => !item.bugId || bugIds.has(item.bugId));
  return { ...data, development };
}
