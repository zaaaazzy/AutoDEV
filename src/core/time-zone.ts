import { ROUTINE_TIME_ZONE, zonedParts, zonedTime } from './cron.js';
import { logOnce } from './log.js';

/**
 * Ortszeit für Tagesgrenzen (Budget-Tag, Burndown): DEV_LOG_TIMEZONE (IANA-Name, z. B. „Europe/Berlin“), sonst
 * Europe/Zurich wie die Routinen. Die Datenbank läuft in UTC; Abfragen rechnen mit AT TIME ZONE in diese Zone um.
 */
export function localTimeZone(environment: NodeJS.ProcessEnv = process.env): string {
  const zone = environment.DEV_LOG_TIMEZONE?.trim();
  if (!zone) return ROUTINE_TIME_ZONE;
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone });
    return zone;
  } catch {
    logOnce('time-zone', `[time-zone] Unbekannte Zeitzone DEV_LOG_TIMEZONE=${zone}, verwende ${ROUTINE_TIME_ZONE}.`);
    return ROUTINE_TIME_ZONE;
  }
}

/** Kalendertag in Ortszeit („YYYY-MM-DD“) und sein Beginn (Mitternacht Ortszeit als ISO-Zeitpunkt). */
export function localDay(now: Date = new Date(), timeZone: string = localTimeZone()): { key: string; since: string } {
  const { year, month, day } = zonedParts(now, timeZone);
  const pad = (value: number) => String(value).padStart(2, '0');
  return {
    key: `${year}-${pad(month)}-${pad(day)}`,
    since: zonedTime(year, month, day, 0, 0, timeZone).toISOString(),
  };
}
