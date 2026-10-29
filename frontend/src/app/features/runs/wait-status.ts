import type { Sprint, TestRun } from '../../core/models.js';
import { type LiveRun, liveStepName } from './test-run-live.js';

/** Was gerade läuft und den Stand bald ändert: Test, Test-Gate, Merge und Push oder die CI-Prüfung auf GitHub. */
export interface WaitStatus {
  /** z. B. „Test läuft“ oder „Push steht an“. */
  label: string;
  /** „bitte warte noch etwa 4 Min.“; leer, wenn keine Schätzung möglich ist. */
  hint: string;
  /** Fortschritt 0–100; null = unbestimmt (keine früheren Läufe zum Vergleich). */
  percent: number | null;
  /** Laufender Testschritt, z. B. „Schritt 3 von 6 · Unit-Tests (inkl. UI-Build) · 120 von 980 Tests“. */
  detail?: string;
}

/** „Schritt 3 von 6 · Unit-Tests“ für den gerade laufenden Schritt; leer, wenn keiner läuft. */
export function runningStep(steps: Pick<LiveRun, 'steps'>['steps']): string {
  const index = steps.findIndex((step) => step.status === 'running');
  if (index < 0) return '';
  const step = steps[index]!;
  return [`Schritt ${index + 1} von ${steps.length}`, liveStepName(step.command), step.progress]
    .filter(Boolean)
    .join(' · ');
}

/** Ab so vielen Prozent zeigt der Balken nicht mehr „fertig“ an, solange der Lauf noch nicht vorbei ist. */
const MAX_RUNNING_PERCENT = 97;

/** Übliche Dauer eines Testlaufs: Median der letzten abgeschlossenen Läufe, bevorzugt mit demselben Auslöser. */
export function typicalRunMs(runs: readonly Pick<TestRun, 'trigger' | 'startedAt' | 'completedAt'>[], trigger: string) {
  const durations = (filter: (run: Pick<TestRun, 'trigger'>) => boolean): number[] =>
    runs
      .filter((run) => run.completedAt && filter(run))
      .map((run) => Date.parse(run.completedAt!) - Date.parse(run.startedAt))
      .filter((ms) => Number.isFinite(ms) && ms > 0)
      .slice(0, 10)
      .sort((left, right) => left - right);
  const same = durations((run) => run.trigger === trigger);
  const pool = same.length ? same : durations(() => true);
  return pool.length ? pool[Math.floor(pool.length / 2)]! : null;
}

function minutesHint(remainingMs: number): string {
  if (remainingMs <= 0) return 'dauert länger als üblich – gleich fertig';
  const minutes = Math.max(1, Math.ceil(remainingMs / 60_000));
  return `bitte warte noch etwa ${minutes} Min.`;
}

/**
 * Wartestatus aus laufendem Testlauf, Git-Sicherung und Pull Request des Sprints; null, wenn nichts ansteht.
 * Restzeit und Fortschritt kommen aus der üblichen Dauer früherer Läufe (Serverzeit `live.now`).
 */
export function waitStatus(
  live: Pick<LiveRun, 'trigger' | 'startedAt' | 'now' | 'steps'> | null,
  sprint: (Pick<Sprint, 'gitSync'> & Partial<Pick<Sprint, 'status' | 'prUrl' | 'ciStatus'>>) | null,
  history: readonly Pick<TestRun, 'trigger' | 'startedAt' | 'completedAt'>[],
): WaitStatus | null {
  const gate = sprint?.gitSync === 'pending' || sprint?.gitSync === 'running';
  if (live) {
    const label = gate ? 'Test-Gate läuft, danach Push' : 'Test läuft';
    const elapsed = Math.max(0, Date.parse(live.now) - Date.parse(live.startedAt));
    const typical = typicalRunMs(history, live.trigger);
    const step = runningStep(live.steps);
    const detail = step ? { detail: step } : {};
    if (typical) {
      return {
        label,
        hint: minutesHint(typical - elapsed),
        percent: Math.min(MAX_RUNNING_PERCENT, Math.round((elapsed / typical) * 100)),
        ...detail,
      };
    }
    // Ohne frühere Läufe gibt es keine Restzeit: nur sagen, wie viele Schritte schon durch sind.
    const done = live.steps.filter((step) => step.status !== 'running').length;
    return { label, hint: `bitte warte · ${done} Schritt(e) erledigt`, percent: null, ...detail };
  }
  if (sprint?.gitSync === 'pending')
    return { label: 'Push steht an', hint: 'startet, sobald der Worker frei ist', percent: null };
  if (sprint?.gitSync === 'running') return { label: 'Merge und Push laufen', hint: 'gleich fertig', percent: null };
  // main liegt in einem anderen Ordner mit offenen Änderungen: Dort übernimmt ein Mensch den Sprint.
  if (sprint?.gitSync === 'awaiting_merge')
    return { label: 'Wartet auf Merge nach main', hint: 'dort von Hand mit git merge übernehmen', percent: null };
  // Pull-Request-Modus: Der Sprint ist gepusht und wartet auf GitHub Actions, danach Merge nach main.
  if (sprint?.status === 'review' && sprint.prUrl) {
    if (sprint.ciStatus === 'pending' || !sprint.ciStatus)
      return { label: 'CI-Prüfung auf GitHub läuft', hint: 'danach Merge nach main', percent: null };
    if (sprint.ciStatus === 'success') return { label: 'Merge nach main', hint: 'gleich fertig', percent: null };
  }
  return null;
}
