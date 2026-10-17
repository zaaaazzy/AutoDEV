import { Component, computed, input } from '@angular/core';

export type ModelProvider = 'claude' | 'copilot' | 'gemini' | 'ollama' | 'custom';

export function providerOf(command: readonly string[] | null | undefined): ModelProvider {
  const program = command?.[0]?.split('/').at(-1)?.toLowerCase();
  if (!program) return 'ollama';
  return program === 'claude' || program === 'copilot' || program === 'gemini' ? program : 'custom';
}

export function providerLabel(command: readonly string[] | null | undefined): string {
  return LABELS[providerOf(command)];
}

const LABELS: Record<ModelProvider, string> = {
  claude: 'Claude (Anthropic)',
  copilot: 'GitHub Copilot',
  gemini: 'Gemini (Google)',
  ollama: 'Lokales Modell (Ollama)',
  custom: 'Eigener Befehl',
};

/** Zeigt das Symbol des Anbieters, der den Agent ausführt. */
@Component({
  selector: 'app-model-icon',
  standalone: true,
  template: `
    <span class="model-icon" [class]="provider()" [attr.title]="label()" role="img" [attr.aria-label]="label()">
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
        @switch (provider()) {
          @case ('claude') {
            <path
              d="M12 2l1.7 6.3L20 6l-4.3 4.9L22 12l-6.3 1.1L20 18l-6.3-2.3L12 22l-1.7-6.3L4 18l4.3-4.9L2 12l6.3-1.1L4 6l6.3 2.3z"
              fill="currentColor"
            />
          }
          @case ('copilot') {
            <path
              d="M12 4c-4.4 0-8 3-8 7v3c0 3 3.6 6 8 6s8-3 8-6v-3c0-4-3.6-7-8-7zm-3 8.5a1.5 1.5 0 110 3 1.5 1.5 0 010-3zm6 0a1.5 1.5 0 110 3 1.5 1.5 0 010-3z"
              fill="currentColor"
            />
          }
          @case ('gemini') {
            <path
              d="M12 2c.6 5.4 4.6 9.4 10 10-5.4.6-9.4 4.6-10 10-.6-5.4-4.6-9.4-10-10 5.4-.6 9.4-4.6 10-10z"
              fill="currentColor"
            />
          }
          @case ('ollama') {
            <path
              d="M8 3c-1 0-2 1.4-2 4 0 1 .2 1.800.6 2.500C5.600 10.500 5 12 5 13.500 5 17.500 8 21 12 21s7-3.500 7-7.500c0-1.500-.6-3-1.600-4C17.800 8.800 18 8 18 7c0-2.600-1-4-2-4-.8 0-1.500 1-1.800 2.600-.7-.2-1.400-.3-2.200-.3s-1.500.1-2.200.3C9.500 4 8.800 3 8 3z"
              fill="currentColor"
            />
          }
          @default {
            <path
              d="M8 7l-5 5 5 5M16 7l5 5-5 5"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
            />
          }
        }
      </svg>
    </span>
  `,
})
export class ModelIconComponent {
  readonly command = input<readonly string[] | null | undefined>(null);
  protected readonly provider = computed(() => providerOf(this.command()));
  protected readonly label = computed(() => LABELS[this.provider()]);
}
