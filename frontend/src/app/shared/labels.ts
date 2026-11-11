import type { DevelopmentItem, DevelopmentStatus, Sprint } from '../core/models.js';
import { DEVELOPMENT_STATUS } from '../core/models.js';

export const DEVELOPMENT_STATUSES: DevelopmentStatus[] = [
  DEVELOPMENT_STATUS.backlog,
  DEVELOPMENT_STATUS.planned,
  DEVELOPMENT_STATUS.inProgress,
  DEVELOPMENT_STATUS.blocked,
  DEVELOPMENT_STATUS.approval,
  DEVELOPMENT_STATUS.done,
  DEVELOPMENT_STATUS.rejected,
];

/** Abgeschlossen: erledigt oder abgelehnt (verstösst gegen die Projektregeln) – zählt nicht mehr als offen. */
export function isFinished(status: string): boolean {
  return status === DEVELOPMENT_STATUS.done || status === DEVELOPMENT_STATUS.rejected;
}

/** „Sprint 1“ statt „Sprint Sprint 1“, wenn der Name schon mit „Sprint“ beginnt. */
export function sprintLabel(name: string): string {
  return /^sprint\b/i.test(name) ? name : `Sprint ${name}`;
}

const STATUS_LABELS: Record<string, string> = {
  running: 'Läuft',
  passed: 'Bestanden',
  failed: 'Fehlgeschlagen',
  skipped: 'Übersprungen',
  waiting: 'Ausstehend',
  idea: 'Erfasst',
  considering: 'In Bearbeitung',
  review: 'Prüfen',
  requested: 'Auftragsbeschreibung wird erstellt',
  drafting: 'Auftragsbeschreibung wird erstellt',
  accepted: 'Auftrag wird bearbeitet',
  implemented: 'Umgesetzt',
  rejected: 'Abgelehnt',
  backlog: 'Backlog',
  planned: 'Geplant',
  in_progress: 'In Arbeit',
  // Blockiert heisst immer: ein Mensch muss etwas tun (erneut versuchen, prüfen, Zugang geben) – ein Begriff überall.
  blocked: 'Aktion notwendig',
  approval: 'Wartet auf Freigabe',
  done: 'Erledigt',
  open: 'Offen',
  fixed: 'Behoben',
  wontfix: 'Kein Fix',
  active: 'Aktiv',
  inactive: 'Inaktiv',
  completed: 'Abgeschlossen',
  cancelled: 'Abgebrochen',
};
const PRIORITY_LABELS: Record<string, string> = { low: 'Niedrig', medium: 'Mittel', high: 'Hoch' };
const SEVERITY_LABELS: Record<string, string> = { ...PRIORITY_LABELS, critical: 'Kritisch' };

export function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

export function statusClass(status: string): string {
  return `status-${status}`;
}

export function priorityLabel(priority: string): string {
  return PRIORITY_LABELS[priority] ?? priority;
}

export function severityLabel(severity: string): string {
  return SEVERITY_LABELS[severity] ?? severity;
}

/** Ampeltext der CI eines Sprint-Pull-Requests. */
export function ciLabel(status: Sprint['ciStatus'] | undefined): string {
  return status === 'success' ? 'grün' : status === 'failure' ? 'rot' : status === 'pending' ? 'läuft' : 'unbekannt';
}

/** Angezeigter Auftragstitel: Bei Bugs ersetzt der Käfer das Präfix „Bug:“. */
export function orderTitle(item: Pick<DevelopmentItem, 'kind' | 'title'>): string {
  return item.kind === 'bug' ? item.title.replace(/^Bug:\s*/i, '') : item.title;
}

export const CATEGORIES = ['frontend', 'backend', 'fullstack', 'infrastructure', 'docs', 'security'] as const;
const CATEGORY_LABELS: Record<string, string> = {
  frontend: 'Frontend',
  backend: 'Backend',
  fullstack: 'Fullstack',
  infrastructure: 'Infrastruktur',
  docs: 'Dokumentation',
  security: 'Sicherheit',
  mixed: 'Gemischt',
};

/** Kategorie eines Sprints aus seinen Aufträgen: eine einzige, Fullstack für Frontend+Backend, sonst gemischt. */
export function combinedCategory(categories: (string | null | undefined)[]): string | null {
  const unique = [...new Set(categories.filter((category): category is string => !!category))];
  if (unique.length <= 1) return unique[0] ?? null;
  return unique.every((category) => ['frontend', 'backend', 'fullstack'].includes(category)) ? 'fullstack' : 'mixed';
}

export function categoryLabel(category: string | null | undefined): string {
  return category ? (CATEGORY_LABELS[category] ?? category) : 'Ohne Kategorie';
}
