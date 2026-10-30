import type { Pool } from 'pg';
import type { CommandExecutor, CommandResult } from '../core/command.js';
import type { KnownBug } from '../api/bugs.js';
import type { AgentStepStatus } from '../core/status.js';

export interface WorkItem {
  id: string;
  projectSlug: string;
  title: string;
  description: string;
  kind?: string;
  bugId?: string | null;
  /** Quelle des Bugs (production, github …): fremde Quellen bekommen im Prompt den Sicherheitshinweis. */
  bugSource?: string | null;
  sprintId?: string | null;
  ideationId?: string | null;
  agentId?: string | null;
  risks?: string;
  /**
   * Kategorie (frontend, backend, fullstack …): Modell-Routing; die visuelle Prüfung läuft nur bei Frontend und
   * Fullstack. Dazu Schätzung (Stunden, samt Herkunft für die Kalibrierung) und Anzahl automatischer Wiederholungen
   * fürs Modell-Routing.
   */
  category?: string | null;
  effortHours?: number | null;
  /** Token-Schätzung (für die Überschreitungsprüfung nach jedem Schritt). */
  tokenEstimate?: number | null;
  estimateSource?: string | null;
  retryCount?: number;
}

export interface PromptExtras {
  bugs?: KnownBug[];
  manual?: string;
  images?: string[];
  /** Branch, gegen den der Reviewer die Änderungen prüft (Sprint- bzw. Basis-Branch). */
  baseBranch?: string | null;
  /** Akzeptanzkriterien aus dem Auftragstext und Definition of Done des Projekts (für den Tester). */
  criteria?: string[];
  definitionOfDone?: string[];
  /** Nachrichten anderer Agents an diesen Agent (@@NACHRICHT). */
  messages?: { from: string; text: string }[];
  /** Ergebnis von „Vor dem Sprint“. */
  sprintNotes?: string | null;
  /** Nur „Bei abgelehnt“ / „Bei abgeschlossen“: wie der Auftrag ausgegangen ist. */
  outcome?: string;
}

/** Runs an agent that has no command of its own (built-in tester or local model). */
export type BuiltinAgent = (context: {
  pool: Pool;
  item: WorkItem;
  agent: WorkflowAgent;
  prompt: string;
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Meldet jede Aktion des Agents (z. B. Dateizugriff) für die Live-Ausgabe. */
  onProgress?: (message: string) => void;
  /** Vom Modell-Routing gewähltes Ollama-Modell (sonst das Modell der Rolle). */
  model?: string;
  /** Nur Tester: vom Auftrag geänderte Dateien (undefined = unbekannt, dann laufen die Testbefehle des Projekts). */
  changedFiles?: string[];
  /**
   * Führt die Shell-Befehle des Agents aus, etwa im Sandbox-Container (sonst runCommand auf dem Host). Beim Tester
   * führt er die Projekttests aus (Testcontainer, mit Diensten nur im Compose-Netzwerk des Projekts).
   */
  execute?: CommandExecutor;
}) => Promise<CommandResult>;

export interface WorkflowAgent {
  id: string;
  name: string;
  role: string;
  phase: string;
  position: number;
  instructions: string;
  command: string[] | null;
  /** Einzeln freigegebene Befehle des Agents (null = Projektstandard). */
  allowedCommands?: string[] | null;
  /** Erlaubte Ordner für Dateirechte (leer = ganzes Projekt). */
  fileScope?: string[];
  /** Empfänger der Nachrichten dieses Agents (null = nächster Agent). */
  handoffTo?: string | null;
  /** Workflow-Schritt, aus dem dieser Einsatz stammt (derselbe Agent kann mehrfach vorkommen). */
  stepId?: string | null;
  /** Anweisung nur für diesen Einsatz, zusätzlich zur Anweisung des Agents. */
  stepInstructions?: string | null;
}

export interface StepSummary {
  agentName: string;
  phase: string;
  status: Extract<AgentStepStatus, 'passed' | 'failed'>;
  output: string;
}

export interface RunnerOptions {
  project: string;
  cwd: string;
  itemId?: string;
  limit: number;
  timeoutMs: number;
  watch: boolean;
  intervalMs: number;
  all?: boolean;
}

export interface WorkItemOptions {
  cwd: string;
  timeoutMs: number;
  execute?: CommandExecutor;
  builtin?: BuiltinAgent;
  /** Pause vor dem einmaligen Wiederholen eines Schritts nach einem vorübergehenden Fehler (Standard 30 s). */
  transientRetryDelayMs?: number;
  /** Pause zwischen den Versuchen, den Abschluss nach einem Datenbankausfall zu speichern (Standard 15 s). */
  settleRetryDelayMs?: number;
  /** Gezielt gestarteter Auftrag (--item): startet unabhängig von Status und Sprint. */
  itemId?: string;
}
