import { Component, input } from '@angular/core';

/**
 * Symbol je Agent-Rolle (Linien-Stil wie die übrigen Symbole); die Rollenbezeichnung ist der Alternativtext.
 * Unbekannte Rollen zeigen das Symbol für „Eigene Rolle“.
 */
@Component({
  selector: 'app-role-icon',
  standalone: true,
  host: {
    class: 'role-icon',
    role: 'img',
    '[attr.aria-label]': "'Rolle: ' + label()",
    '[attr.title]': 'label()',
    '[attr.data-role]': 'key()',
  },
  template: `
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      @switch (key()) {
        @case ('author') {
          <path d="M4 20h4L19 9l-4-4L4 16z" />
          <path d="M13.5 6.5l4 4" />
        }
        @case ('developer') {
          <path d="M8 8l-4 4 4 4M16 8l4 4-4 4M13.5 5l-3 14" />
        }
        @case ('tester') {
          <path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.7 3h10.6a2 2 0 0 0 1.7-3l-5-9V3" />
          <path d="M7.5 15h9" />
        }
        @case ('visual_tester') {
          <path d="M4 8h3l2-3h6l2 3h3v11H4z" />
          <circle cx="12" cy="13" r="3.5" />
        }
        @case ('reviewer') {
          <circle cx="10.5" cy="10.5" r="6" />
          <path d="M15 15l5 5M8 10.5l2 2 3.5-4" />
        }
        @case ('documenter') {
          <path d="M6 3h8l4 4v14H6z" />
          <path d="M14 3v4h4M9 12h6M9 16h6" />
        }
        @case ('bug_reviewer') {
          <path d="M9 7.5a3 3 0 0 1 6 0" />
          <rect x="7" y="7.5" width="10" height="12" rx="5" />
          <path d="M12 11v8.5M7 12H3.5M20.5 12H17M7.5 16.5l-3 2M16.5 16.5l3 2" />
        }
        @case ('manual_writer') {
          <path d="M4 5h6a2 2 0 0 1 2 2v13a2 2 0 0 0-2-2H4z" />
          <path d="M20 5h-6a2 2 0 0 0-2 2v13a2 2 0 0 1 2-2h6z" />
          <path d="M15 9h3M15 12h3" />
        }
        @case ('user_manual_writer') {
          <path d="M4 5h6a2 2 0 0 1 2 2v13a2 2 0 0 0-2-2H4z" />
          <path d="M20 5h-6a2 2 0 0 0-2 2v13a2 2 0 0 1 2-2h6z" />
          <circle cx="7" cy="10" r="1.5" />
          <path d="M5 14.5a2.5 2.5 0 0 1 4 0" />
        }
        @case ('assistant') {
          <path d="M4 5h16v11H9l-5 4z" />
          <path d="M8.5 10.5h.01M12 10.5h.01M15.5 10.5h.01" />
        }
        @case ('visionary') {
          <path d="M9 18h6M10 21h4" />
          <path d="M12 3a6 6 0 0 0-3.5 10.9c.5.4.5 1.1.5 2.1h6c0-1 0-1.7.5-2.1A6 6 0 0 0 12 3z" />
        }
        @default {
          <circle cx="12" cy="12" r="3" />
          <path
            d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"
          />
        }
      }
    </svg>
  `,
})
export class RoleIconComponent {
  /** Rollenschlüssel, z. B. `developer` (siehe `agentRole()` in agent-options.ts). */
  readonly key = input.required<string>();
  /** Deutsche Bezeichnung der Rolle, z. B. „Entwickler“. */
  readonly label = input.required<string>();
}
