import { defined } from './defined.js';

/**
 * Kleiner Cron-Parser für Routinen (5 Felder: Minute Stunde Tag Monat Wochentag) ohne Abhängigkeiten. Die Zeiten
 * gelten in einer Zeitzone (Standard Europe/Zurich) samt Sommer-/Winterzeit. Reiner Code ohne Node-APIs, damit die
 * Oberfläche dieselbe Berechnung für die Vorschau „nächster Lauf“ nutzt.
 *
 * Zeitumstellung: Eine Uhrzeit, die es beim Wechsel auf Sommerzeit nicht gibt (02:30), läuft um die Länge der Lücke
 * später (03:30). Eine Uhrzeit, die es beim Wechsel auf Winterzeit doppelt gibt, läuft genau einmal (beim ersten Mal).
 */
export const ROUTINE_TIME_ZONE = 'Europe/Zurich';

export interface CronSchedule {
  minutes: number[];
  hours: number[];
  days: Set<number>;
  months: Set<number>;
  weekdays: Set<number>;
  /** Tag bzw. Wochentag eingeschränkt (nicht „*“): beide eingeschränkt → einer von beiden genügt (wie Vixie-Cron). */
  dayRestricted: boolean;
  weekdayRestricted: boolean;
}

const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const WEEKDAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const FIELDS: { name: string; min: number; max: number; names?: string[]; offset?: number }[] = [
  { name: 'Minute', min: 0, max: 59 },
  { name: 'Stunde', min: 0, max: 23 },
  { name: 'Tag', min: 1, max: 31 },
  { name: 'Monat', min: 1, max: 12, names: MONTH_NAMES, offset: 1 },
  { name: 'Wochentag', min: 0, max: 7, names: WEEKDAY_NAMES, offset: 0 },
];

function parseValue(raw: string, field: (typeof FIELDS)[number]): number | null {
  const named = field.names?.indexOf(raw.toLowerCase()) ?? -1;
  if (named >= 0) return named + (field.offset ?? 0);
  if (!/^\d{1,2}$/.test(raw)) return null;
  const value = Number(raw);
  return value >= field.min && value <= field.max ? value : null;
}

function parseField(text: string, field: (typeof FIELDS)[number]): Set<number> | string {
  const values = new Set<number>();
  for (const part of text.split(',')) {
    const [range = '', stepText] = part.split('/');
    const step = stepText === undefined ? 1 : /^\d{1,2}$/.test(stepText) ? Number(stepText) : 0;
    if (step < 1) return `${field.name}: ungültige Schrittweite „${part}“.`;
    let from: number | null;
    let to: number | null;
    if (range === '*') {
      from = field.min;
      to = field.max;
    } else if (range.includes('-')) {
      const [a = '', b = ''] = range.split('-');
      from = parseValue(a, field);
      to = parseValue(b, field);
    } else {
      from = parseValue(range, field);
      to = stepText === undefined ? from : field.max;
    }
    if (from === null || to === null || from > to) return `${field.name}: ungültiger Wert „${part}“.`;
    for (let value = from; value <= to; value += step) values.add(value);
  }
  return values;
}

/** Liest einen Cron-Ausdruck mit 5 Feldern; liefert den Fehlertext, wenn er ungültig ist. */
export function parseCron(expression: string): CronSchedule | string {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5 || !parts[0])
    return 'Cron-Ausdruck braucht genau 5 Felder (Minute Stunde Tag Monat Wochentag).';
  const sets: Set<number>[] = [];
  for (const [index, field] of FIELDS.entries()) {
    const parsed = parseField(defined(parts[index]), field);
    if (typeof parsed === 'string') return parsed;
    sets.push(parsed);
  }
  const [minutes, hours, days, months, weekdays] = sets as [
    Set<number>,
    Set<number>,
    Set<number>,
    Set<number>,
    Set<number>,
  ];
  // 7 = Sonntag wie 0.
  if (weekdays.has(7)) weekdays.add(0);
  return {
    minutes: [...minutes].sort((a, b) => a - b),
    hours: [...hours].sort((a, b) => a - b),
    days,
    months,
    weekdays,
    dayRestricted: parts[2] !== '*',
    weekdayRestricted: parts[4] !== '*',
  };
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** Wanduhr in der Zeitzone zu einem Zeitpunkt. */
export function zonedParts(
  at: Date,
  timeZone = ROUTINE_TIME_ZONE,
): { year: number; month: number; day: number; hour: number; minute: number; weekday: number } {
  let format = formatters.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
    });
    formatters.set(timeZone, format);
  }
  const parts: Record<string, number> = {};
  for (const part of format.formatToParts(at)) if (part.type !== 'literal') parts[part.type] = Number(part.value);
  const year = defined(parts.year);
  const month = defined(parts.month);
  const day = defined(parts.day);
  return {
    year,
    month,
    day,
    hour: defined(parts.hour) % 24,
    minute: defined(parts.minute),
    weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
  };
}

/** Abstand der Zeitzone zu UTC (ms) zu einem Zeitpunkt. */
function offsetAt(utcMs: number, timeZone: string): number {
  const p = zonedParts(new Date(utcMs), timeZone);
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  return wall - Math.floor(utcMs / 60_000) * 60_000;
}

/**
 * Zeitpunkt zu einer Wanduhrzeit: doppelte Uhrzeit (Winterzeit) → das erste Vorkommen, fehlende Uhrzeit
 * (Sommerzeit) → um die Lücke später.
 */
export function zonedTime(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone = ROUTINE_TIME_ZONE,
): Date {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const before = offsetAt(wall - 12 * 3_600_000, timeZone);
  const after = offsetAt(wall + 12 * 3_600_000, timeZone);
  const matches = [...new Set([before, after])]
    .map((offset) => wall - offset)
    .filter((utc) => {
      const p = zonedParts(new Date(utc), timeZone);
      return p.year === year && p.month === month && p.day === day && p.hour === hour && p.minute === minute;
    })
    .sort((a, b) => a - b);
  return new Date(matches[0] ?? wall - before);
}

/** Nächster Lauf strikt nach `after`; null, wenn der Ausdruck in den nächsten Jahren nie zutrifft (z. B. 31. Februar). */
export function nextCronRun(schedule: CronSchedule | string, after: Date, timeZone = ROUTINE_TIME_ZONE): Date | null {
  const cron = typeof schedule === 'string' ? parseCron(schedule) : schedule;
  if (typeof cron === 'string') return null;
  const start = zonedParts(after, timeZone);
  const base = Date.UTC(start.year, start.month - 1, start.day);
  for (let offset = 0; offset < 366 * 5; offset += 1) {
    const date = new Date(base + offset * 86_400_000);
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth() + 1;
    const day = date.getUTCDate();
    if (!cron.months.has(month)) continue;
    const dayMatch = cron.days.has(day);
    const weekdayMatch = cron.weekdays.has(date.getUTCDay());
    const matches =
      cron.dayRestricted && cron.weekdayRestricted
        ? dayMatch || weekdayMatch
        : (!cron.dayRestricted || dayMatch) && (!cron.weekdayRestricted || weekdayMatch);
    if (!matches) continue;
    for (const hour of cron.hours) {
      // Am Starttag frühere Stunden überspringen (eine Stunde Reserve für die Zeitumstellung).
      if (offset === 0 && hour < start.hour - 1) continue;
      for (const minute of cron.minutes) {
        const at = zonedTime(year, month, day, hour, minute, timeZone);
        if (at.getTime() > after.getTime()) return at;
      }
    }
  }
  return null;
}

const WEEKDAY_LABELS = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
const pad = (value: number): string => String(value).padStart(2, '0');

/** Kurzform für die Vorschau: „Mo 07:00“, mehr als eine Woche entfernt „Mo 01.12. 07:00“. */
export function formatRun(at: Date, now = new Date(), timeZone = ROUTINE_TIME_ZONE): string {
  const p = zonedParts(at, timeZone);
  const time = `${pad(p.hour)}:${pad(p.minute)}`;
  const far = at.getTime() - now.getTime() > 6 * 86_400_000;
  return `${WEEKDAY_LABELS[p.weekday]} ${far ? `${pad(p.day)}.${pad(p.month)}. ` : ''}${time}`;
}

/** Zeitfenster „HH:MM-HH:MM“ (z. B. 22:00-06:00 über Mitternacht); null = kein Fenster. */
export function parseWindow(text: string): { start: number; end: number } | null | string {
  const value = text.trim();
  if (!value) return null;
  const match = /^([01]\d|2[0-3]):([0-5]\d)\s*-\s*([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!match) return 'Zeitfenster im Format HH:MM-HH:MM angeben, z. B. 22:00-06:00.';
  const start = Number(match[1]) * 60 + Number(match[2]);
  const end = Number(match[3]) * 60 + Number(match[4]);
  if (start === end) return 'Zeitfenster: Beginn und Ende dürfen nicht gleich sein.';
  return { start, end };
}

/** Liegt der Zeitpunkt im Zeitfenster (Wanduhr der Zeitzone, Ende ausgeschlossen)? */
export function inWindow(at: Date, window: string | null, timeZone = ROUTINE_TIME_ZONE): boolean {
  const parsed = window ? parseWindow(window) : null;
  if (!parsed || typeof parsed === 'string') return true;
  const p = zonedParts(at, timeZone);
  const minute = p.hour * 60 + p.minute;
  return parsed.start < parsed.end
    ? minute >= parsed.start && minute < parsed.end
    : minute >= parsed.start || minute < parsed.end;
}

/** Nächster Lauf, der auch im Zeitfenster liegt (Läufe außerhalb des Fensters werden übersprungen). */
export function nextRoutineRun(
  schedule: string,
  window: string | null,
  after: Date,
  timeZone = ROUTINE_TIME_ZONE,
): Date | null {
  const cron = parseCron(schedule);
  if (typeof cron === 'string') return null;
  let cursor = after;
  for (let tries = 0; tries < 2000; tries += 1) {
    const next = nextCronRun(cron, cursor, timeZone);
    if (!next || inWindow(next, window, timeZone)) return next;
    cursor = next;
  }
  return null;
}

/** Zeitplan aus der einfachen Auswahl der Oberfläche: täglich bzw. wöchentlich um HH:MM. */
export function simpleCron(kind: 'daily' | 'weekly', time: string, weekday = 1): string | null {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(time.trim());
  if (!match) return null;
  const base = `${Number(match[2])} ${Number(match[1])} * *`;
  return kind === 'daily' ? `${base} *` : `${base} ${weekday % 7}`;
}

/** Umgekehrt: erkennt „täglich“/„wöchentlich“ in einem Ausdruck, sonst „eigener Cron“. */
export function describeCron(
  expression: string,
): { kind: 'daily'; time: string } | { kind: 'weekly'; time: string; weekday: number } | { kind: 'custom' } {
  const match = /^(\d{1,2}) (\d{1,2}) \* \* (\*|[0-7])$/.exec(expression.trim());
  if (!match || Number(match[1]) > 59 || Number(match[2]) > 23) return { kind: 'custom' };
  const time = `${pad(Number(match[2]))}:${pad(Number(match[1]))}`;
  return match[3] === '*' ? { kind: 'daily', time } : { kind: 'weekly', time, weekday: Number(match[3]) % 7 };
}
