import type { RequestHandler } from 'express';
import { fullPath } from './security.js';

/**
 * Rollen: Jede schreibende Aktion gehört zu genau einer Rolle. Lesen dürfen alle angemeldeten Benutzer.
 * „admin“ umfasst alle Rollen; der Zugang aus der .env ist immer Administrator (kein Aussperren möglich).
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
type Rule = [method: string, pattern: RegExp, role: Role | null | ((body: unknown) => RoleRequirement)];

/**
 * PATCH eines Auftrags: Einen Agent starten ({ agentId: "<id>" } allein) ist Ausführen. Jede andere Änderung ist
 * Planung – auch agentId: null, das nichts startet. Kommen ein Agent und weitere Felder zusammen, braucht es beide
 * Rollen, sonst änderte „Ausführen“ über agentId den ganzen Auftrag (oder „Planung“ startete einen Agent).
 */
function developmentPatchRole(body: unknown): RoleRequirement {
  if (typeof body !== 'object' || body === null || !('agentId' in body)) return 'plan';
  if (typeof (body as { agentId: unknown }).agentId !== 'string') return 'plan';
  return Object.keys(body).length === 1 ? 'run' : ['plan', 'run'];
}

/** null = jeder angemeldete Benutzer (eigenes Konto, eigene Geräte). Unbekannte Routen verlangen Administration. */
const RULES: Rule[] = [
  ['POST', /^\/api\/(login|logout)$/, null],
  ['POST', /^\/api\/auth\//, null],
  ['POST', /^\/api\/push\//, null],
  ['*', /^\/api\/users/, 'admin'],
  ['PUT', /^\/api\/settings$/, 'admin'],
  // Review-Container freigeben ist Administration, einen Stand starten oder beenden ist Ausführen.
  ['PUT', /^\/api\/review-slots\/\d+$/, 'admin'],
  ['POST', /^\/api\/review-slots\/\d+\/stop$/, 'run'],
  ['POST', /^\/api\/projects\/[^/]+\/review-slots\/start$/, 'run'],
  ['POST', /^\/api\/projects$/, 'admin'],
  ['POST', /^\/api\/projects\/setup$/, 'admin'],
  ['POST', /^\/api\/setup\/jobs$/, 'admin'],
  ['PATCH', /^\/api\/projects\/[^/]+$/, 'admin'],
  ['PUT', /^\/api\/projects\/[^/]+\/permissions$/, 'admin'],
  // Budget-Limits, Währung/Kurs und Modell-Routing (inkl. CLI-Befehl der starken Stufe): Administration.
  ['PUT', /^\/api\/projects\/[^/]+\/budget$/, 'admin'],
  // Ingest-Token des Produktions-Rückkanals erzeugen, rotieren, entfernen. Der Ingest-Endpunkt selbst
  // (POST /api/ingest/<projekt>/<token>) liegt vor dem Login und braucht weder Anmeldung noch Rolle.
  ['*', /^\/api\/projects\/[^/]+\/ingest-token$/, 'admin'],
  // Eigene Rechte-Gruppen anlegen, ändern, löschen: nur Administration.
  ['*', /^\/api\/projects\/[^/]+\/permission-groups(?:\/[^/]+)?$/, 'admin'],
  ['PUT', /^\/api\/system-agents\//, 'admin'],
  ['POST', /^\/api\/projects\/[^/]+\/agents\/[^/]+\/cancel$/, 'run'],
  ['POST', /^\/api\/projects\/[^/]+\/agents(\/(defaults|order))?$/, 'agents'],
  ['*', /^\/api\/agents\//, 'agents'],
  // Workflow-Schritte (welcher Agent wann läuft) gehören zur Agent-Verwaltung.
  ['*', /^\/api\/projects\/[^/]+\/workflow\/(steps|order)$/, 'agents'],
  ['*', /^\/api\/workflow-steps\//, 'agents'],
  // Review-Freigabe: freigeben, zurückweisen oder in der Review-Instanz anzeigen gehört zum Ausführen.
  ['POST', /^\/api\/development\/[^/]+\/(retry|analyze|approve|review-reject|show-review)$/, 'run'],
  // Optische Freigabe im Reiter „Ansicht“ ist wie die Review-Freigabe Ausführen.
  ['POST', /^\/api\/development\/[^/]+\/visual\/approve$/, 'run'],
  ['POST', /^\/api\/sprints\/[^/]+\/git-sync$/, 'run'],
  ['POST', /^\/api\/sprints\/[^/]+\/(pause|resume)$/, 'run'],
  // Einen Agent für einen Auftrag starten ist Ausführen, alles andere am Auftrag ist Planung.
  ['PATCH', /^\/api\/development\/[^/]+$/, developmentPatchRole],
  ['*', /^\/api\/development\//, 'plan'],
  ['POST', /^\/api\/projects\/[^/]+\/(development|ideation|bugs|sprints)$/, 'plan'],
  // Visionär-Lauf starten bzw. abbrechen: legt Ideen an, gehört also zur Planung.
  ['POST', /^\/api\/projects\/[^/]+\/ideation\/visionary(\/cancel)?$/, 'plan'],
  ['POST', /^\/api\/projects\/[^/]+\/sprints\/(proposal\/(apply|comment)|autopilot\/resume)$/, 'plan'],
  ['*', /^\/api\/(ideation|bugs|sprints)\//, 'plan'],
  ['*', /^\/api\/(projects\/[^/]+\/)?attachments/, 'plan'],
  ['*', /^\/api\/(ideation|development|bugs)\/[^/]+\/attachments/, 'plan'],
  ['POST', /^\/api\/projects\/[^/]+\/docs$/, 'docs'],
  ['POST', /^\/api\/docs\/[^/]+\/revisions$/, 'docs'],
  ['POST', /^\/api\/doc-revisions\/[^/]+\/(approve|reject)$/, 'editor'],
  ['*', /^\/api\/docs\//, 'editor'],
  ['*', /^\/api\/projects\/[^/]+\/chat$/, 'chat'],
  // Agent-Aufgaben definieren, starten, nach Zeitplan pausieren/fortsetzen und ihren Verlauf ansehen gehört zum
  // Arbeiten mit dem Assistenten.
  ['*', /^\/api\/(projects\/[^/]+\/agent-tasks$|agent-tasks\/[^/]+(\/(run|runs|pause|resume))?$)/, 'chat'],
  ['POST', /^\/api\/projects\/[^/]+\/test-requests$/, 'run'],
  // AIdeation neu starten (Container neu bauen, Worker neu starten): betrifft alle Projekte.
  ['POST', /^\/api\/system\/restart$/, 'admin'],
  // Wartungs-Jobs des Workers (Zeitplan, Konfiguration): nur Administration; GET prüft die Route selbst.
  ['*', /^\/api\/scheduled-jobs(?:\/[^/]+)?$/, 'admin'],
];

export function requiredRole(method: string, path: string, body: unknown): RoleRequirement | null {
  for (const [ruleMethod, pattern, role] of RULES) {
    if ((ruleMethod === '*' || ruleMethod === method) && pattern.test(path)) {
      return typeof role === 'function' ? role(body) : role;
    }
  }
  return 'admin';
}

/** Prüft schreibende Anfragen gegen die Rollen des angemeldeten Benutzers (res.locals.principal). */
export const authorize: RequestHandler = (request, response, next) => {
  const path = fullPath(request);
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method) || !path.startsWith('/api/')) {
    next();
    return;
  }
  const required = requiredRole(request.method, path, request.body);
  const principal = response.locals.principal as Principal | undefined;
  const role = (typeof required === 'string' ? [required] : (required ?? [])).find(
    (candidate) => !hasRole(principal, candidate),
  );
  if (!role) {
    next();
    return;
  }
  response.status(403).json({ message: `Dafür fehlt dir die Rolle „${ROLE_INFO[role].label}“.` });
};
