import { defined } from './defined.js';

/**
 * Arbeitszeiten eines Projekts für den Sprint-Autopilot: Zeitfenster „HH:MM“–„HH:MM“ an ausgewählten Wochentagen
 * (1 = Montag … 7 = Sonntag, ISO). Ein Fenster über Mitternacht (22:00–06:00) gehört zum Tag, an dem es beginnt;
 * gleiche Start- und Endzeit bedeutet ganztägig. Massgeblich ist die Ortszeit des Workers.
 */
export interface WorkingHours {
  start: string;
  end: string;
  days: number[];
}

export const DEFAULT_WORKING_HOURS: WorkingHours = { start: '08:00', end: '18:00', days: [1, 2, 3, 4, 5] };
export const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

const minutesOf = (time: string): number => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
const isoDay = (date: Date): number => date.getDay() || 7;

export function isValidWorkingHours(value: WorkingHours): boolean {
  return (
    TIME_PATTERN.test(value.start) &&
    TIME_PATTERN.test(value.end) &&
    value.days.length > 0 &&
    value.days.length <= 7 &&
    value.days.every((day) => Number.isInteger(day) && day >= 1 && day <= 7) &&
    new Set(value.days).size === value.days.length
  );
}

export function withinWorkingHours(now: Date, hours: WorkingHours): boolean {
  const minute = now.getHours() * 60 + now.getMinutes();
  const start = minutesOf(hours.start);
  const end = minutesOf(hours.end);
  const today = isoDay(now);
  if (start === end) return hours.days.includes(today);
  if (start < end) return hours.days.includes(today) && minute >= start && minute < end;
  // Über Mitternacht: am Starttag ab Beginn, am Folgetag bis zum Ende.
  if (minute >= start) return hours.days.includes(today);
  return minute < end && hours.days.includes(today === 1 ? 7 : today - 1);
}

const DAY_LABELS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];

/** Kurzform für Meldungen, z. B. „Mo–Fr 08:00–18:00“ bzw. „Mo, Mi 08:00–18:00“. */
export function describeWorkingHours(hours: WorkingHours): string {
  const days = [...hours.days].sort((a, b) => a - b);
  const consecutive = days.every((day, index) => index === 0 || day === defined(days[index - 1]) + 1);
  const label =
    days.length === 7
      ? 'täglich'
      : consecutive && days.length > 2
        ? `${DAY_LABELS[defined(days[0]) - 1]}–${DAY_LABELS[defined(days[days.length - 1]) - 1]}`
        : days.map((day) => DAY_LABELS[day - 1]).join(', ');
  return `${label} ${hours.start}–${hours.end}`;
}
