import type { DevelopmentStatus } from '../core/models.js';

export const DEVELOPMENT_STATUSES: DevelopmentStatus[] = [
  'backlog',
  'planned',
  'in_progress',
  'blocked',
  'approval',
  'done',
  'rejected',
];

/** Abgeschlossen: erledigt oder abgelehnt (verstösst gegen die Projektregeln) – zählt nicht mehr als offen. */
export function isFinished(status: string): boolean {
  return status === 'done' || status === 'rejected';
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

export const CATEGORIES = ['frontend', 'backend', 'fullstack', 'infrastructure', 'docs'] as const;
const CATEGORY_LABELS: Record<string, string> = {
  frontend: 'Frontend',
  backend: 'Backend',
  fullstack: 'Fullstack',
  infrastructure: 'Infrastruktur',
  docs: 'Dokumentation',
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
