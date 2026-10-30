import type { Section } from './navigation.js';

/** Zahlen, aus denen die Menü-Bubbles entstehen. */
export interface NavCountSource {
  /** Offene oder in Arbeit befindliche Bugs. */
  openBugs: number;
  /** Ideen, die noch nicht angenommen oder abgelehnt sind. */
  openIdeas: number;
  /** Einträge auf der Seite „Aktionen“. */
  attention: number;
  /** Agents, die gerade arbeiten. */
  runningAgents: number;
}

/**
 * Zahl in der Menü-Bubble. Nur Bereiche, in denen etwas auf dich wartet oder gerade läuft, bekommen eine Bubble:
 * Bugs, offene Ideen, Aktionen und laufende Agents. Alle anderen Bereiche bleiben ohne Zahl (0 = keine Bubble).
 */
export function navCount(section: Section, source: NavCountSource): number {
  switch (section) {
    case 'bugs':
      return source.openBugs;
    case 'ideation':
      return source.openIdeas;
    case 'actions':
      return source.attention;
    case 'agents':
      return source.runningAgents;
    default:
      return 0;
  }
}

/** Ton der Sprint-Bubble in der Kopfzeile. */
export type SprintTone = 'ok' | 'warn' | 'stopped' | 'paused';

/** Zustand des Sprint-Chips (Kopfzeile und Handy). */
export type SprintState = 'done' | 'stopped' | 'paused' | 'warn' | 'running' | 'idle';

/**
 * Ton und Text der Sprint-Bubble. Vorrang: Worker offline > pausiert > Fehler > läuft.
 * Ein pausierter Sprint läuft nicht, auch wenn noch ein Auftrag blockiert ist.
 */
export function sprintHealthOf(input: { workerDown: boolean; paused: boolean; failed: boolean }): {
  tone: SprintTone;
  text: string;
} {
  if (input.workerDown) return { tone: 'stopped', text: 'Sprint gestoppt: Worker offline' };
  if (input.paused) return { tone: 'paused', text: 'Sprint pausiert' };
  if (input.failed) return { tone: 'warn', text: 'Sprint läuft mit Fehlern' };
  return { tone: 'ok', text: 'Sprint läuft' };
}

/** Zustand des Sprint-Chips. Vorrang: fertig > Worker offline > pausiert > Fehler > läuft oder wartet. */
export function sprintStateOf(input: { finished: boolean; tone: SprintTone | undefined; busy: boolean }): SprintState {
  if (input.finished) return 'done';
  if (input.tone === 'stopped') return 'stopped';
  if (input.tone === 'paused') return 'paused';
  if (input.tone === 'warn') return 'warn';
  return input.busy ? 'running' : 'idle';
}
