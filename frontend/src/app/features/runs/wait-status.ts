import type { Sprint, TestRun } from '../../core/models.js';
import type { LiveRun } from './test-run-live.js';

/** Was gerade läuft und den Stand im Review-Container bald ändert: Test, Test-Gate oder ausstehender Push. */
export interface WaitStatus {
  /** z. B. „Test läuft“ oder „Push steht an“. */
  label: string;
  /** „bitte warte noch etwa 4 Min.“; leer, wenn keine Schätzung möglich ist. */
  hint: string;
  /** Fortschritt 0–100; null = unbestimmt (keine früheren Läufe zum Vergleich). */
  percent: number | null;
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
 * Wartestatus aus laufendem Testlauf und Git-Sicherung des aktiven Sprints; null, wenn nichts ansteht.
 * Restzeit und Fortschritt kommen aus der üblichen Dauer früherer Läufe (Serverzeit `live.now`).
 */
export function waitStatus(
  live: Pick<LiveRun, 'trigger' | 'startedAt' | 'now' | 'steps'> | null,
  sprint: Pick<Sprint, 'gitSync'> | null,
  history: readonly Pick<TestRun, 'trigger' | 'startedAt' | 'completedAt'>[],
): WaitStatus | null {
  const gate = sprint?.gitSync === 'pending' || sprint?.gitSync === 'running';
  if (live) {
    const label = gate ? 'Test-Gate läuft, danach Push' : 'Test läuft';
    const elapsed = Math.max(0, Date.parse(live.now) - Date.parse(live.startedAt));
    const typical = typicalRunMs(history, live.trigger);
    if (typical) {
      return {
        label,
        hint: minutesHint(typical - elapsed),
        percent: Math.min(MAX_RUNNING_PERCENT, Math.round((elapsed / typical) * 100)),
      };
    }
    // Ohne frühere Läufe gibt es keine Restzeit: nur sagen, wie viele Schritte schon durch sind.
    const done = live.steps.filter((step) => step.status !== 'running').length;
    return { label, hint: `bitte warte · ${done} Schritt(e) erledigt`, percent: null };
  }
  if (sprint?.gitSync === 'pending')
    return { label: 'Push steht an', hint: 'startet, sobald der Worker frei ist', percent: null };
  if (sprint?.gitSync === 'running') return { label: 'Merge und Push laufen', hint: 'gleich fertig', percent: null };
  return null;
}
