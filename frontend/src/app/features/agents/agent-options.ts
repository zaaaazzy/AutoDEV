import type { AgentPhase } from '../../core/models.js';

export const AGENT_ROLES = [
  { value: 'author', label: 'Auftragsautor' },
  { value: 'developer', label: 'Entwickler' },
  { value: 'tester', label: 'Tester' },
  { value: 'visual_tester', label: 'Visueller Tester' },
  { value: 'reviewer', label: 'Reviewer' },
  { value: 'documenter', label: 'Dokumentierer' },
  { value: 'bug_reviewer', label: 'Bug-Wächter' },
  { value: 'manual_writer', label: 'Handbuch-Autor' },
  { value: 'user_manual_writer', label: 'Benutzerhandbuch-Autor' },
  { value: 'custom', label: 'Eigene Rolle' },
];

/** Spalten des Workflow-Boards in Ablauf-Reihenfolge. */
export const AGENT_PHASES: { id: AgentPhase; label: string; hint: string }[] = [
  { id: 'pre_sprint', label: 'Vor dem Sprint', hint: 'Einmal beim Sprintstart · nur lesend (Planung, Prüfung)' },
  { id: 'pre_task', label: 'Vor dem Auftrag', hint: 'Kontext prüfen und Auftrag vorbereiten' },
  { id: 'while_task', label: 'Während', hint: 'Auftrag umsetzen' },
  { id: 'after_task', label: 'Danach', hint: 'Tests, Review und Dokumentation' },
  { id: 'on_rejected', label: 'Bei abgelehnt', hint: 'Wenn der Auftrag scheitert · ändert das Ergebnis nicht' },
  { id: 'on_done', label: 'Bei abgeschlossen', hint: 'Wenn der Auftrag erledigt ist · ändert das Ergebnis nicht' },
];

export function phaseLabel(phase: string): string {
  return AGENT_PHASES.find((item) => item.id === phase)?.label ?? phase;
}

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

const PROVIDER_ORDER = ['local', 'claude', 'copilot', 'gemini'];

export const MODEL_PRESETS: ModelPreset[] = (
  [
    { id: 'local', label: 'Lokal (Ollama qwen3.5:9b)', tier: 0, command: '' },
    {
      id: 'claude-haiku',
      label: 'Claude Haiku',
      tier: 1,
      command: 'claude --model haiku --permission-mode acceptEdits -p {prompt}',
    },
    {
      id: 'claude-sonnet',
      label: 'Claude Sonnet',
      tier: 2,
      command: 'claude --model sonnet --permission-mode acceptEdits -p {prompt}',
    },
    {
      id: 'claude-opus',
      label: 'Claude Opus',
      tier: 3,
      command: 'claude --model opus --permission-mode acceptEdits -p {prompt}',
    },
    {
      id: 'copilot',
      label: 'GitHub Copilot (Standardmodell)',
      tier: 2,
      command: 'copilot --allow-all-tools -p {prompt}',
    },
    { id: 'gemini-flash', label: 'Gemini 2.5 Flash', tier: 1, command: 'gemini -m gemini-2.5-flash -p {prompt}' },
    { id: 'gemini-pro', label: 'Gemini 2.5 Pro', tier: 2, command: 'gemini -m gemini-2.5-pro -p {prompt}' },
  ] satisfies ModelPreset[]
).sort(
  (a, b) =>
    PROVIDER_ORDER.indexOf(a.id.split('-')[0] ?? '') - PROVIDER_ORDER.indexOf(b.id.split('-')[0] ?? '') ||
    a.tier - b.tier,
);

export function presetLabel(preset: ModelPreset): string {
  return `${preset.label} · ${preset.tier === 0 ? 'Kostenlos' : '$'.repeat(preset.tier)}`;
}

export function presetOf(command: string): string {
  return MODEL_PRESETS.find((preset) => preset.command === command.trim())?.id ?? 'custom';
}

/** Genaue Modellangabe eines Agent-Befehls, z. B. „Claude Opus“, „Gemini 2.5 Pro“ oder „Ollama · qwen3.5:9b“. */
export function modelLabel(command: readonly string[] | null | undefined, localModel?: string | null): string {
  if (!command?.length)
    return localModel
      ? `Ollama · ${localModel}`
      : (MODEL_PRESETS.find((p) => p.id === 'local')?.label ?? 'Lokal (Ollama)');
  const preset = MODEL_PRESETS.find((p) => p.command && p.command === command.join(' '));
  if (preset) return preset.label;
  const program = command[0]?.split('/').at(-1) ?? '';
  const flag = command.findIndex((part) => part === '--model' || part === '-m');
  const model = flag >= 0 ? command[flag + 1] : undefined;
  const name = { claude: 'Claude', copilot: 'GitHub Copilot', gemini: 'Gemini' }[program] ?? program;
  if (!model) return name;
  return program === 'claude' ? `${name} ${model.charAt(0).toUpperCase()}${model.slice(1)}` : `${name} · ${model}`;
}
