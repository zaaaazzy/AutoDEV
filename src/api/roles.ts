/**
 * Rollen: Jede schreibende Aktion gehört zu genau einer Rolle. Lesen dürfen alle angemeldeten Benutzer.
 * „admin“ umfasst alle Rollen; der Zugang aus der .env ist immer Administrator (kein Aussperren möglich).
 * Welche Rolle eine Route braucht, steht bei der Route (access in access.ts).
 */
export const ROLES = ['admin', 'agents', 'run', 'plan', 'docs', 'editor', 'chat'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_INFO: Record<Role, { label: string; description: string }> = {
  admin: {
    label: 'Administration',
    description: 'Benutzer und Rollen, Projekte anlegen und einstellen, Agent-Rechte, globale Einstellungen.',
  },
  agents: { label: 'Agents verwalten', description: 'Agents anlegen, ändern, löschen und ordnen.' },
  run: {
    label: 'Agents ausführen',
    description: 'Agents starten und abbrechen, Aufträge erneut versuchen und analysieren, Git-Abgleich.',
  },
  plan: { label: 'Planung', description: 'Ideen, Aufträge, Bugs, Sprints und Anhänge erstellen und bearbeiten.' },
  docs: { label: 'Dokumentation bearbeiten', description: 'Handbücher anlegen und Änderungen zur Prüfung einreichen.' },
  editor: {
    label: 'Redaktion',
    description: 'Eingereichte Dokumentänderungen prüfen, freigeben oder ablehnen; Dokumente löschen.',
  },
  chat: { label: 'Assistent nutzen', description: 'Mit dem Dashboard-Assistenten arbeiten.' },
};

export interface Principal {
  /** null = Systemadministrator aus der .env */
  id: string | null;
  username: string;
  displayName: string;
  roles: Role[];
}

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

export function hasRole(principal: Principal | undefined, role: Role): boolean {
  return Boolean(principal && (principal.roles.includes('admin') || principal.roles.includes(role)));
}

/** Eine Rolle oder mehrere, die alle vorhanden sein müssen. */
export type RoleRequirement = Role | readonly Role[];
/** Rolle einer schreibenden Route: null = jeder angemeldete Benutzer, Funktion = abhängig vom Body. */
export type RoleRule = RoleRequirement | null | ((body: unknown) => RoleRequirement);

/** Erste geforderte Rolle, die dem Benutzer fehlt; undefined = alles vorhanden. */
export function missingRole(principal: Principal | undefined, required: RoleRequirement | null): Role | undefined {
  return (typeof required === 'string' ? [required] : (required ?? [])).find(
    (candidate) => !hasRole(principal, candidate),
  );
}

/**
 * PATCH eines Auftrags: Einen Agent starten ({ agentId: "<id>" } allein) ist Ausführen. Jede andere Änderung ist
 * Planung – auch agentId: null, das nichts startet. Kommen ein Agent und weitere Felder zusammen, braucht es beide
 * Rollen, sonst änderte „Ausführen“ über agentId den ganzen Auftrag (oder „Planung“ startete einen Agent).
 */
export function developmentPatchRole(body: unknown): RoleRequirement {
  if (typeof body !== 'object' || body === null || !('agentId' in body)) return 'plan';
  if (typeof (body as { agentId: unknown }).agentId !== 'string') return 'plan';
  return Object.keys(body).length === 1 ? 'run' : ['plan', 'run'];
}
