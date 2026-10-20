import type { TaskRun } from '../../core/agent-actions.service.js';
import { formatRun, nextRoutineRun, parseCron, parseWindow, simpleCron } from '../../../../../src/core/cron.js';

/** Zeitplan im Formular der Agent-Aufgaben: dieselbe Cron-Berechnung wie im Worker (src/core/cron.ts). */
export type ScheduleKind = 'none' | 'daily' | 'weekly' | 'custom';

/** Wochentage für „Wöchentlich am…“ (Cron: 0 = Sonntag), beginnend mit Montag. */
export const WEEKDAYS: { value: number; label: string }[] = [
  { value: 1, label: 'Montag' },
  { value: 2, label: 'Dienstag' },
  { value: 3, label: 'Mittwoch' },
  { value: 4, label: 'Donnerstag' },
  { value: 5, label: 'Freitag' },
  { value: 6, label: 'Samstag' },
  { value: 0, label: 'Sonntag' },
];

/** Cron-Ausdruck aus der Auswahl; schedule null = kein Zeitplan, error gesetzt = ungültig. */
export function scheduleFrom(
  kind: ScheduleKind,
  time: string,
  weekday: number,
  cron: string,
): { schedule: string | null; error: string | null } {
  if (kind === 'none') return { schedule: null, error: null };
  if (kind === 'custom') {
    const parsed = parseCron(cron);
    return typeof parsed === 'string'
      ? { schedule: null, error: parsed }
      : { schedule: cron.trim().replace(/\s+/g, ' '), error: null };
  }
  const schedule = simpleCron(kind, time, weekday);
  return schedule ? { schedule, error: null } : { schedule: null, error: 'Uhrzeit im Format HH:MM angeben.' };
}

/** Vorschau „nächster Lauf: Mo 07:00“ (Europe/Zurich), sonst ein Hinweis. */
export function previewText(schedule: string | null, window: string, now = new Date()): string {
  if (!schedule) return 'Ohne Zeitplan – nur per Klick.';
  const parsedWindow = parseWindow(window);
  if (typeof parsedWindow === 'string') return parsedWindow;
  const next = nextRoutineRun(schedule, parsedWindow ? window.replace(/\s+/g, '') : null, now);
  return next ? `nächster Lauf: ${formatRun(next, now)}` : 'Der Zeitplan trifft nie zu.';
}

/** Dauer kurz: „42 s“, „3 min 5 s“. */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '–';
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

export const RUN_STATUS_LABELS: Record<TaskRun['status'], string> = {
  queued: 'wartet',
  running: 'läuft',
  ok: 'ok',
  failed: 'Fehler',
  cancelled: 'abgebrochen',
};
