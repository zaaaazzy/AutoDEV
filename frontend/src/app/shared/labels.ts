import type { DevelopmentStatus } from '../core/models.js';

export const DEVELOPMENT_STATUSES: DevelopmentStatus[] = ['backlog', 'planned', 'in_progress', 'blocked', 'done'];

const STATUS_LABELS: Record<string, string> = {
  running: 'Läuft',
  passed: 'Bestanden',
  failed: 'Fehlgeschlagen',
  skipped: 'Übersprungen',
  waiting: 'Ausstehend',
  idea: 'Idee',
  considering: 'In Abklärung',
  requested: 'Wird ausformuliert',
  drafting: 'Wird ausformuliert',
  accepted: 'Auftrag erstellt',
  rejected: 'Verworfen',
  backlog: 'Backlog',
  planned: 'Geplant',
  in_progress: 'In Arbeit',
  blocked: 'Blockiert',
  done: 'Erledigt',
  open: 'Offen',
  fixed: 'Behoben',
  wontfix: 'Kein Fix',
  active: 'Aktiv',
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
