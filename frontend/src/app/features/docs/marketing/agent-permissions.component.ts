import { Component } from '@angular/core';
import { MermaidDirective } from '../../../shared/mermaid.directive.js';
import { AGENT_ROLES, PHASE_LABELS, phaseDiagram } from './agent-permissions.js';

/** Statische Seite „Agents, Aufgaben und Rechte“ (Dokumentation → Marketing). Keine API-Daten. */
@Component({
  selector: 'app-agent-permissions',
  standalone: true,
  imports: [MermaidDirective],
  templateUrl: './agent-permissions.component.html',
})
export class AgentPermissionsComponent {
  protected readonly roles = AGENT_ROLES;
  protected readonly phaseLabels = PHASE_LABELS;
  protected readonly diagram = phaseDiagram();
}
