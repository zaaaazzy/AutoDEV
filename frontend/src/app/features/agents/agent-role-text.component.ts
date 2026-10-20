import { HttpClient } from '@angular/common/http';
import { Component, computed, inject, input, signal } from '@angular/core';
import {
  AGENT_ROLE_TEXTS_URL,
  type AgentRoleTexts,
  parseRoleTexts,
  ROLE_TEXT_FALLBACK,
  ROLE_TEXT_LOAD_ERROR,
  roleTextViews,
} from './agent-role-text.js';

/**
 * Zeigt Aufgabe und Nutzen einer Agent-Rolle aus `public/data/agent-rollen-texte.json`. Ohne `role` alle Rollen
 * in der Reihenfolge von `AGENT_ROLES`. Unbekannte Rollen bekommen einen neutralen Text, ein Ladefehler eine Meldung.
 */
@Component({
  selector: 'app-agent-role-text',
  standalone: true,
  templateUrl: './agent-role-text.component.html',
})
export class AgentRoleTextComponent {
  private readonly http = inject(HttpClient);

  /** Rollenschlüssel wie `author`; leer = alle Rollen. */
  readonly role = input<string | null>(null);

  readonly fallback = ROLE_TEXT_FALLBACK;
  readonly loadError = ROLE_TEXT_LOAD_ERROR;
  readonly texts = signal<AgentRoleTexts | null>(null);
  readonly failed = signal(false);
  readonly views = computed(() => roleTextViews(this.role(), this.texts() ?? {}));

  constructor() {
    this.http.get<unknown>(AGENT_ROLE_TEXTS_URL).subscribe({
      next: (data) => this.texts.set(parseRoleTexts(data)),
      error: () => this.failed.set(true),
    });
  }
}
