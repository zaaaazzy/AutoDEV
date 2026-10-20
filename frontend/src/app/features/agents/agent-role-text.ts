import { AGENT_ROLES } from './agent-options.js';

/** Pfad der gepflegten Rollentexte (frontend/public), relativ zum `<base href>`. */
export const AGENT_ROLE_TEXTS_URL = 'data/agent-rollen-texte.json';

/** Ein Eintrag aus `agent-rollen-texte.json`. */
export interface AgentRoleText {
  rolle: string;
  beschreibung: string;
  nutzen: string;
}

export type AgentRoleTexts = Record<string, AgentRoleText>;

/** Was die Komponente je Rolle anzeigt; `text` ist null, wenn die Datei keinen Eintrag hat. */
export interface AgentRoleView {
  key: string;
  label: string;
  text: AgentRoleText | null;
}

export const ROLE_TEXT_FALLBACK = 'Zu dieser Rolle ist noch keine Beschreibung hinterlegt.';
export const ROLE_TEXT_LOAD_ERROR = 'Die Rollenbeschreibungen konnten nicht geladen werden.';

function isRoleText(value: unknown): value is AgentRoleText {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  return ['rolle', 'beschreibung', 'nutzen'].every((field) => typeof entry[field] === 'string' && entry[field]);
}

/** Übernimmt nur vollständige Einträge; alles andere fällt später auf den neutralen Text zurück. */
export function parseRoleTexts(data: unknown): AgentRoleTexts {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
  return Object.fromEntries(Object.entries(data).filter(([, value]) => isRoleText(value))) as AgentRoleTexts;
}

/** Anzeigename aus `AGENT_ROLES`; nur für unbekannte Schlüssel der Name aus der Datei oder der Schlüssel selbst. */
export function roleTextView(key: string, texts: AgentRoleTexts): AgentRoleView {
  const text = Object.hasOwn(texts, key) ? (texts[key] ?? null) : null;
  const label = AGENT_ROLES.find((role) => role.value === key)?.label ?? text?.rolle ?? key;
  return { key, label, text };
}

/** Ohne Schlüssel alle Rollen in der Reihenfolge von `AGENT_ROLES`. */
export function roleTextViews(key: string | null | undefined, texts: AgentRoleTexts): AgentRoleView[] {
  return (key ? [key] : AGENT_ROLES.map((role) => role.value)).map((role) => roleTextView(role, texts));
}
