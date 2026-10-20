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
