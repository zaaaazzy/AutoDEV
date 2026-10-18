import type { Pool } from 'pg';
import { requestVisionaryRun } from '../agent/visionary.js';
import { hasRole, type Principal, type Role } from './roles.js';

/**
 * System-Agents, die man im Dashboard-Chat mit @ ansprechen kann. Sie sind keine Projekt-Agents (keine Zeile in
 * `agents`), sondern lösen eine eigene Aktion aus. Die Oberfläche lädt die Liste, neue Einträge erscheinen dort
 * automatisch in der @-Auswahl.
 */
export interface ChatTarget {
  id: string;
  name: string;
  /** Was das Ansprechen bewirkt (Hinweis in der Auswahl). */
  description: string;
  /** Recht, das man dafür braucht (zusätzlich zum Chat-Recht). */
  role: Role;
  /** Führt die Anfrage aus und liefert die Antwort, die sofort im Chat erscheint. */
  handle: (pool: Pool, slug: string, content: string, principal: Principal | undefined) => Promise<string>;
}

const who = (principal: Principal | undefined): string => principal?.displayName || principal?.username || 'Nutzer';

export const CHAT_TARGETS: readonly ChatTarget[] = [
  {
    id: 'visionary',
    name: 'Visionär',
    description: 'Schlägt begründete Erweiterungsideen vor. Der Text nach @Visionär ist der Schwerpunkt.',
    role: 'plan',
    handle: async (pool, slug, content, principal) => {
      const id = await requestVisionaryRun(pool, slug, who(principal), { focus: content, replyInChat: true });
      return id
        ? `Ich sehe mir das Projekt an und schlage Ideen${content ? ` zum Schwerpunkt „${content.slice(0, 200)}“` : ''} vor. Das Ergebnis melde ich hier, die Ideen erscheinen unter Ideation.`
        : 'Für dieses Projekt läuft bereits ein Visionär-Lauf. Den Fortschritt siehst du unter Ideation; das Ergebnis melde ich hier.';
    },
  },
];

/** Ansprechbare System-Agents für diesen Benutzer (ohne das nötige Recht nicht in der Auswahl). */
export function chatTargetsFor(principal: Principal | undefined) {
  return CHAT_TARGETS.filter((target) => hasRole(principal, target.role)).map(({ id, name, description }) => ({
    id,
    name,
    description,
  }));
}
