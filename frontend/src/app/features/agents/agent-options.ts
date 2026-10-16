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

export interface ModelPreset {
  id: string;
  label: string;
  /** 0 = kostenlos, 1–3 = $ bis $$$ (grobe Richtwerte, Abrechnung beim jeweiligen Anbieter). */
  tier: 0 | 1 | 2 | 3;
  command: string;
}

export const MODEL_PRESETS: ModelPreset[] = (
  [
    { id: 'local', label: 'Lokal (Ollama qwen3.5:9b)', tier: 0, command: '' },
    {
      id: 'gemini-flash',
      label: 'Gemini 2.5 Flash (Gemini CLI)',
      tier: 1,
      command: 'gemini -m gemini-2.5-flash -p {prompt}',
    },
    {
      id: 'claude-haiku',
      label: 'Claude Haiku (Claude Code)',
      tier: 1,
      command: 'claude --model haiku --permission-mode acceptEdits -p {prompt}',
    },
    {
      id: 'copilot',
      label: 'GitHub Copilot CLI (Standardmodell)',
      tier: 2,
      command: 'copilot --allow-all-tools -p {prompt}',
    },
    {
      id: 'gemini-pro',
      label: 'Gemini 2.5 Pro (Gemini CLI)',
      tier: 2,
      command: 'gemini -m gemini-2.5-pro -p {prompt}',
    },
    {
      id: 'claude-sonnet',
      label: 'Claude Sonnet (Claude Code)',
      tier: 2,
      command: 'claude --model sonnet --permission-mode acceptEdits -p {prompt}',
    },
    {
      id: 'claude-opus',
      label: 'Claude Opus (Claude Code)',
      tier: 3,
      command: 'claude --model opus --permission-mode acceptEdits -p {prompt}',
    },
  ] satisfies ModelPreset[]
).sort((a, b) => a.tier - b.tier || a.label.localeCompare(b.label));

export function presetLabel(preset: ModelPreset): string {
  return `${preset.label} · ${preset.tier === 0 ? 'Kostenlos' : '$'.repeat(preset.tier)}`;
}

export function presetOf(command: string): string {
  return MODEL_PRESETS.find((preset) => preset.command === command.trim())?.id ?? 'custom';
}
