import type { AgentPhase } from '../../core/models.js';

export const AGENT_ROLES = [
  { value: 'author', label: 'Auftragsautor' },
  { value: 'developer', label: 'Entwickler' },
  { value: 'tester', label: 'Tester' },
  { value: 'reviewer', label: 'Reviewer' },
  { value: 'documenter', label: 'Dokumentierer' },
  { value: 'bug_reviewer', label: 'Bug-Wächter' },
  { value: 'manual_writer', label: 'Handbuch-Autor' },
  { value: 'user_manual_writer', label: 'Benutzerhandbuch-Autor' },
  { value: 'custom', label: 'Eigene Rolle' },
];

export const AGENT_PHASES: { id: AgentPhase; label: string; hint: string }[] = [
  { id: 'pre_task', label: 'Vorbereitung', hint: 'Kontext prüfen und Auftrag vorbereiten' },
  { id: 'while_task', label: 'Umsetzung', hint: 'Auftrag bearbeiten' },
  { id: 'after_task', label: 'Abschluss', hint: 'Tests, Review und Dokumentation' },
];

export function roleLabel(role: string): string {
  return AGENT_ROLES.find((item) => item.value === role)?.label ?? role;
}

/** Leerer Text ergibt null (eingebauter Agent), `[...]` wird als JSON-Array gelesen, sonst an Leerzeichen getrennt. */
export function parseCommand(text: string): string[] | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('[')) {
    const value: unknown = JSON.parse(trimmed);
    if (Array.isArray(value) && value.every((part: unknown) => typeof part === 'string')) return value;
    throw new Error('Der Befehl im JSON-Format muss ein Array aus Textwerten sein.');
  }
  return trimmed.split(/\s+/);
}
