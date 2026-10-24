import type { Bug, BugStatus, Sprint } from '../../core/models.js';
import type { FormValues } from '../../shared/forms.js';

/** Reihenfolge überall gleich: aufsteigend nach Schwere. */
export const SEVERITIES: { value: Bug['severity']; label: string }[] = [
  { value: 'low', label: 'Niedrig' },
  { value: 'medium', label: 'Mittel' },
  { value: 'high', label: 'Hoch' },
  { value: 'critical', label: 'Kritisch' },
];

/** Diese Status legen den Bug auf den Friedhof; in der Oberfläche gibt es von dort keinen Weg zurück. */
export const BURYING_STATUSES = new Set<BugStatus>(['fixed', 'wontfix', 'rejected']);

/** Höchstlänge beim Bearbeiten (DB-Grenze); neue Bugs haben kürzere Titel (API: TITLE_MAX). */
export const EDIT_TITLE_MAX = 180;

/**
 * Sprints, denen ein Bug zugeordnet werden kann: keine abgeschlossenen oder abgebrochenen. Der aktuelle Sprint des
 * Bugs bleibt auswählbar, sonst zeigte die Auswahl ein leeres Feld.
 */
export function selectableSprints(sprints: Sprint[], currentId: string | null = null): Sprint[] {
  return sprints.filter(
    (sprint) => sprint.id === currentId || (sprint.status !== 'completed' && sprint.status !== 'cancelled'),
  );
}

type BugChanges = Partial<Pick<Bug, 'title' | 'description' | 'severity' | 'sprintId' | 'fixNotes' | 'category'>>;

/**
 * Nur die geänderten Felder des Bearbeiten-Formulars, normalisiert wie in der API (Texte getrimmt, leere Auswahl =
 * null). Unveränderte Felder gehen nicht mit, damit Speichern keine Änderung eines Agents an anderen Feldern
 * überschreibt.
 */
export function bugChanges(bug: Bug, values: FormValues): BugChanges {
  const text = (key: string): string => String(values[key] ?? '');
  const choice = (key: string): string | null => (values[key] ? String(values[key]) : null);
  const next: BugChanges = {
    title: text('title').trim(),
    description: text('description').trim(),
    severity: text('severity') as Bug['severity'],
    sprintId: choice('sprintId'),
    fixNotes: text('fixNotes').trim(),
    category: choice('category') as Bug['category'],
  };
  const current: BugChanges = {
    title: bug.title,
    description: bug.description,
    severity: bug.severity,
    sprintId: bug.sprintId ?? null,
    fixNotes: bug.fixNotes ?? '',
    category: bug.category ?? null,
  };
  return Object.fromEntries(
    Object.entries(next).filter(([key, value]) => value !== current[key as keyof BugChanges]),
  ) as BugChanges;
}
