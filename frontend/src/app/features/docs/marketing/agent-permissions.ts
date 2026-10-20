/**
 * Inhalte der Marketing-Seite „Agents, Aufgaben und Rechte“. Quelle ist ausschließlich docs/agents-und-rechte.md
 * (Abschnitt 3, Tabelle „Workflow-Agents“, und Abschnitt 4). Ändert sich das Dokument, hier nachziehen – die Spec
 * prüft Phasen und Dateirechte gegen die Tabelle im Dokument.
 */

export type AgentPhase = 'pre_task' | 'while_task' | 'after_task' | 'frei';

/** Alle Werte von agents.role (docs/erm.md), in der Reihenfolge der Tabelle. */
export const AGENT_ROLE_KEYS = [
  'author',
  'developer',
  'tester',
  'visual_tester',
  'reviewer',
  'documenter',
  'bug_reviewer',
  'manual_writer',
  'user_manual_writer',
  'custom',
] as const;
export type AgentRoleKey = (typeof AGENT_ROLE_KEYS)[number];

export interface AgentRoleInfo {
  role: AgentRoleKey;
  name: string;
  /** Sichtbares Symbol; `iconLabel` ist der Text für Screenreader. */
  icon: string;
  iconLabel: string;
  phase: AgentPhase;
  /** Kurzbeschreibung, höchstens zwei Sätze. */
  summary: string;
  task: string;
  files: string;
  commands: string;
  scenarios: string;
  argument: string;
}

export const PHASE_LABELS: Record<AgentPhase, string> = {
  pre_task: 'Vor dem Auftrag',
  while_task: 'Während des Auftrags',
  after_task: 'Nach dem Auftrag',
  frei: 'frei wählbar',
};

/** Eine Zeile je Rolle, Reihenfolge nach Ablauf: pre_task → while_task → after_task → custom. */
export const AGENT_ROLES: readonly AgentRoleInfo[] = [
  {
    role: 'author',
    name: 'Auftragsautor',
    icon: '📝',
    iconLabel: 'Notizblock',
    phase: 'pre_task',
    summary:
      'Beschreibt den Auftrag mit Ziel, Kriterien, Dateien und Diagrammen. Stammt der Auftrag aus einer Idee, wird er übersprungen.',
    task: 'Auftrag beschreiben (Ziel, Kriterien, Dateien, Diagramme). Wird übersprungen, wenn der Auftrag aus einer Idee stammt.',
    files: 'nein',
    commands: 'nein',
    scenarios: 'Ein Auftrag wird ohne Idee angelegt und braucht eine prüfbare Beschreibung.',
    argument: 'Jeder Auftrag startet mit klaren Kriterien, ohne dass der Agent Dateien anfasst.',
  },
  {
    role: 'bug_reviewer',
    name: 'Bug-Wächter',
    icon: '🐞',
    iconLabel: 'Käfer',
    phase: 'pre_task',
    summary:
      'Prüft bekannte Bugs und hält daraus Risiken am Auftrag fest. Sind schon Risiken vorhanden, wird er übersprungen.',
    task: 'Bekannte Bugs prüfen → Risiken beim Auftrag. Übersprungen, wenn schon Risiken vorhanden.',
    files: 'nein',
    commands: 'nein',
    scenarios: 'Vor der Umsetzung soll klar sein, welche früheren Fehler den Auftrag betreffen.',
    argument: 'Bekannte Fehler fließen vor der Umsetzung in den Auftrag ein.',
  },
  {
    role: 'developer',
    name: 'Entwickler',
    icon: '🛠️',
    iconLabel: 'Werkzeug',
    phase: 'while_task',
    summary:
      'Setzt den Auftrag im Projektordner um. Bei Bug-Aufträgen wird seine Ausgabe als Fix-Notiz am Bug gespeichert.',
    task: 'Auftrag umsetzen. Bei Bug-Aufträgen wird die Ausgabe als Fix-Notiz am Bug gespeichert.',
    files: 'ja, mit Backup in .dev-log-backups/',
    commands: 'npm test/run/install, git status/diff/log',
    scenarios: 'Neue Funktion, Umbau oder Bugfix im Projekt-Repository.',
    argument: 'Änderungen landen mit Backup – vorherige Stände bleiben in .dev-log-backups/ erhalten.',
  },
  {
    role: 'tester',
    name: 'Tester',
    icon: '🧪',
    iconLabel: 'Reagenzglas',
    phase: 'after_task',
    summary: 'Schreibt Tests und prüft die Abnahmekriterien. Build und Projekttests führt danach der Runner aus.',
    task: 'Tests schreiben, danach führt der Runner Build und Projekttests aus; Abnahme der Kriterien.',
    files: 'ja (Claude-CLI: alle freigeschalteten Gruppen)',
    commands: 'über die Rechte-Gruppen; Projekttests führt der Runner aus',
    scenarios: 'Nach der Umsetzung sollen Kriterien geprüft und Tests ergänzt werden.',
    argument: 'Jede Umsetzung wird gegen ihre Kriterien geprüft, bevor sie weitergeht.',
  },
  {
    role: 'visual_tester',
    name: 'Visueller Tester',
    icon: '📸',
    iconLabel: 'Kamera',
    phase: 'after_task',
    summary:
      'Macht bei Frontend- und Fullstack-Aufträgen Screenshots der Vorschau für Desktop und Handy und vergleicht sie. Ohne preview_url wird er übersprungen.',
    task: 'Nur bei Frontend/Fullstack: Screenshots der Vorschau (Desktop, Handy), Pixel-Vergleich, Layout-Prüfungen. Ohne preview_url übersprungen.',
    files: 'nein (Bilder nur temporär unter .dev-log/visual/ fürs KI-Urteil)',
    commands: 'nein; der eigene Befehl dient nur dem optionalen KI-Urteil',
    scenarios: 'Oberflächen-Änderungen, bei denen Layout auf Desktop und Handy zählt.',
    argument: 'Optische Änderungen werden per Screenshot sichtbar, nicht nur im Code.',
  },
  {
    role: 'reviewer',
    name: 'Reviewer',
    icon: '🔍',
    iconLabel: 'Lupe',
    phase: 'after_task',
    summary: 'Prüft die Änderungen des Auftrags. Er muss mit @@REVIEW: FREIGEGEBEN ausdrücklich freigeben.',
    task: 'Änderungen prüfen; muss mit @@REVIEW: FREIGEGEBEN ausdrücklich freigeben.',
    files: 'nur lesen (Prompt); Claude-CLI: alle Gruppen',
    commands: 'über die Rechte-Gruppen',
    scenarios: 'Zweite Meinung zu jeder Änderung vor dem Abschluss.',
    argument: 'Ohne ausdrückliche Freigabe gilt eine Änderung nicht als geprüft.',
  },
  {
    role: 'documenter',
    name: 'Dokumentierer',
    icon: '📄',
    iconLabel: 'Dokument',
    phase: 'after_task',
    summary: 'Dokumentiert das Ergebnis eines Auftrags. Daraus entsteht die Auftragsdoku.',
    task: 'Ergebnis dokumentieren → Auftragsdoku.',
    files: 'lokales Modell nein; Claude-CLI anlegen + ändern',
    commands: 'nein',
    scenarios: 'Nachvollziehen, was in einem Auftrag geändert wurde.',
    argument: 'Jeder Auftrag hinterlässt eine Dokumentation seines Ergebnisses.',
  },
  {
    role: 'manual_writer',
    name: 'Handbuch-Autor',
    icon: '📘',
    iconLabel: 'Blaues Buch',
    phase: 'after_task',
    summary: 'Pflegt das technische Handbuch.',
    task: 'Technisches Handbuch pflegen.',
    files: 'lokales Modell nein; Claude-CLI anlegen + ändern',
    commands: 'nein',
    scenarios: 'Technische Doku soll nach Änderungen aktuell bleiben.',
    argument: 'Das technische Handbuch wird im Ablauf mitgepflegt.',
  },
  {
    role: 'user_manual_writer',
    name: 'Benutzerhandbuch-Autor',
    icon: '📗',
    iconLabel: 'Grünes Buch',
    phase: 'after_task',
    summary: 'Pflegt das Benutzerhandbuch.',
    task: 'Benutzerhandbuch pflegen.',
    files: 'lokales Modell nein; Claude-CLI anlegen + ändern',
    commands: 'nein',
    scenarios: 'Anleitungen für Nutzer sollen zu neuen Funktionen passen.',
    argument: 'Nutzer finden Änderungen auch im Benutzerhandbuch wieder.',
  },
  {
    role: 'custom',
    name: 'Eigene Rolle',
    icon: '🧩',
    iconLabel: 'Puzzleteil',
    phase: 'frei',
    summary: 'Beliebige Zusatzrolle für eigene Schritte im Ablauf.',
    task: 'Beliebige Zusatzrolle.',
    files: 'nein',
    commands: 'nein',
    scenarios: 'Ein Projekt braucht einen zusätzlichen, eigenen Prüf- oder Arbeitsschritt.',
    argument: 'Der Ablauf lässt sich je Projekt um eigene Rollen erweitern.',
  },
];

/** Mermaid-Ablauf: die drei Phasen mit ihren Rollen (custom ist frei und fehlt darum). */
export function phaseDiagram(roles: readonly AgentRoleInfo[] = AGENT_ROLES): string {
  const lines = ['flowchart LR', '  start[Auftrag ausführbar] --> pre_task'];
  const phases: AgentPhase[] = ['pre_task', 'while_task', 'after_task'];
  for (const phase of phases) {
    lines.push(`  subgraph ${phase}[${phase}]`);
    for (const role of roles.filter((entry) => entry.phase === phase)) lines.push(`    ${role.role}[${role.name}]`);
    lines.push('  end');
  }
  lines.push('  pre_task --> while_task', '  while_task --> after_task');
  return lines.join('\n');
}

/** Adresse der Seite im Dokumentationsbereich (ohne Router: über den Hash). */
export const AGENT_PERMISSIONS_HASH = '#docs/marketing/agent-permissions';

export function isAgentPermissionsHash(hash: string): boolean {
  return hash.split('?')[0] === AGENT_PERMISSIONS_HASH;
}
