export interface TimelineEntry {
  at: string;
  kind: 'created' | 'status' | 'step' | 'analysis' | 'question' | 'answer' | 'bugfix';
  title: string;
  detail?: string;
  state?: 'passed' | 'failed' | 'running' | 'info';
  /** Nur bei Rückfragen: schon beantwortet. */
  answered?: boolean;
}

export interface OrderTimeline {
  waiting: { label: string; tone: 'ok' | 'wait' | 'you' | 'problem' };
  entries: TimelineEntry[];
}

/** Beantwortete Rückfragen und die Antworten darauf sind erledigt und erscheinen nicht mehr in der Zeitleiste. */
export function visibleTimelineEntries(entries: TimelineEntry[]): TimelineEntry[] {
  return entries.filter((entry) => entry.kind !== 'answer' && !(entry.kind === 'question' && entry.answered));
}
