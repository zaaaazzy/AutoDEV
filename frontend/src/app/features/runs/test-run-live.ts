/** Ein Schritt des gerade laufenden Testlaufs (GET /projects/:slug/test-runs/live). */
export interface LiveStep {
  position: number;
  command: string;
  status: 'running' | 'passed' | 'failed';
  category: string | null;
  progress: string | null;
  durationMs: number | null;
  startedAt: string | null;
  output: string;
}

export interface LiveRun {
  id: string;
  trigger: string;
  branch: string | null;
  startedAt: string;
  /** Serverzeit der Antwort: Laufzeiten unabhängig von der Uhr des Geräts. */
  now: string;
  steps: LiveStep[];
}

/** Name eines Schritts aus seinem Befehl: „npx playwright test -c e2e/full.config.ts“ → „Oberflächentest“. */
export function liveStepName(command: string): string {
  if (/full\.config/.test(command)) return 'Oberflächentest';
  if (/playwright/.test(command)) return 'E2E-Tests';
  if (/lint|eslint/.test(command)) return 'Lint';
  if (/format|prettier/.test(command)) return 'Formatierung';
  if (/typecheck|tsc/.test(command)) return 'Typprüfung';
  if (/build:ui/.test(command)) return 'UI-Build';
  if (/^npm test\b|\bnpm test$/.test(command)) return 'Unit-Tests (inkl. UI-Build)';
  return command.replace(/^npm (run )?/, '');
}

/** Bisherige bzw. gesamte Dauer eines Schritts in Millisekunden. */
export function liveStepMs(step: LiveStep, now: string): number | null {
  if (step.durationMs !== null) return step.durationMs;
  return step.startedAt ? Math.max(0, Date.parse(now) - Date.parse(step.startedAt)) : null;
}
