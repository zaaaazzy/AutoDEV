/**
 * Autopilot-Sprintplanung (deterministisch, ohne Modell): bewertet offene Aufträge, füllt den Sprint bis zur
 * gemessenen Kapazität und legt die Reihenfolge fest – Folgeaufträge nach ihrem Vorgänger, Aufträge mit
 * denselben Dateien direkt hintereinander (passt zur Projektsperre).
 */
export interface PlanCandidate {
  id: string;
  title: string;
  priority: 'low' | 'medium' | 'high';
  kind: 'feature' | 'bug';
  benefit: number | null;
  cost: number | null;
  effortHours: number | null;
  tokenEstimate: number | null;
  followUpOf: string | null;
  /** War schon einmal blockiert oder aus einem Sprint genommen. */
  troubled: boolean;
  /** Aus dem vorigen Sprint übernommen („Aktion notwendig“) – wird immer eingeplant. */
  carryOver: boolean;
  files: string[];
}

export interface PlannedItem {
  id: string;
  title: string;
  score: number;
  reason: string;
  hours: number;
  tokens: number | null;
  selected: boolean;
  rank: number | null;
  /** „Aktion notwendig“ aus dem vorigen Sprint: wartet auf einen Menschen. */
  carryOver: boolean;
}

export interface Capacity {
  hours: number;
  tokens: number | null;
  source: 'history' | 'setting';
}

export interface SprintProposal {
  capacity: Capacity;
  items: PlannedItem[];
  totals: { hours: number; tokens: number };
}

const PRIORITY_WEIGHT = { high: 3, medium: 2, low: 1 } as const;
const PRIORITY_LABEL = { high: 'hoch', medium: 'mittel', low: 'niedrig' } as const;
/** Ohne Schätzung zählt ein Auftrag mit diesem Aufwand gegen die Kapazität. */
export const DEFAULT_ORDER_HOURS = 2;

export function scoreOf(candidate: PlanCandidate, predecessorDone: boolean): number {
  const benefit = candidate.benefit ?? 5;
  const cost = candidate.cost ?? 5;
  let score = (PRIORITY_WEIGHT[candidate.priority] * (benefit + 1)) / (cost + 1);
  if (candidate.kind === 'bug') score += 2;
  if (candidate.followUpOf && predecessorDone) score += 1;
  if (candidate.troubled) score -= 1.5;
  return Math.round(score * 100) / 100;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/**
 * Kapazität = Median der erledigten Ist-Stunden (bzw. Ist-Tokens) der letzten 3 abgeschlossenen Sprints, aber nie
 * weniger als die Einstellung. Sonst schrumpft sie von selbst: Ein Sprint schafft höchstens, was eingeplant war, und
 * die Ist-Stunden sind Rechenzeit der Agents (ein auf 2 h geschätzter Auftrag ist oft in 15 Minuten fertig) – nach
 * wenigen Sprints passte kein Auftrag mehr hinein. Die Historie hebt die Kapazität also nur an. Sprints ohne gemessene
 * Stunden zählen nicht als Historie; eine Token-Grenze gilt nur, wenn die Historie die Kapazität bestimmt.
 */
export function capacityFrom(history: { hours: number; tokens: number }[], settingHours: number): Capacity {
  const recent = history.filter((sprint) => sprint.hours > 0).slice(0, 3);
  const hours = median(recent.map((sprint) => sprint.hours));
  if (hours === null || hours <= settingHours) return { hours: settingHours, tokens: null, source: 'setting' };
  const tokens = median(recent.map((sprint) => sprint.tokens).filter((value) => value > 0));
  return { hours, tokens, source: 'history' };
}

/** Dateien aus „Technische Hinweise (betroffene Dateien …)“ bzw. in Backticks gesetzte Pfade der Beschreibung. */
export function affectedFiles(description: string): string[] {
  const section = description.match(
    /(?:^|\n)##[^\n]*(?:betroffene Dateien|Technische Hinweise)[^\n]*\n([\s\S]*?)(?=\n## |$)/i,
  )?.[1];
  const source = section ?? '';
  const files = new Set<string>();
  for (const match of source.matchAll(/`([^`\s]+\.[a-z0-9]{1,6})`|(?:^|\s)((?:[\w.-]+\/)+[\w.-]+\.[a-z0-9]{1,6})/gim)) {
    files.add((match[1] ?? match[2])!.replace(/^\.\//, ''));
  }
  return [...files];
}

function reasonOf(candidate: PlanCandidate, predecessorTitle: string | null): string {
  const parts = [`Priorität ${PRIORITY_LABEL[candidate.priority]}`];
  if (candidate.benefit !== null || candidate.cost !== null)
    parts.push(`Nutzen ${candidate.benefit ?? '–'} / Kosten ${candidate.cost ?? '–'}`);
  if (candidate.kind === 'bug') parts.push('Bug');
  if (predecessorTitle) parts.push(`folgt auf „${predecessorTitle}“`);
  if (candidate.troubled) parts.push('war blockiert');
  if (candidate.carryOver) parts.push('aus dem vorigen Sprint übernommen');
  return parts.join(' · ');
}

/**
 * Vorschlag: übernommene Aufträge zuerst, dann nach Bewertung, solange die Kapazität reicht. Ein Folgeauftrag
 * kommt nur in den Sprint, wenn sein Vorgänger erledigt ist oder vor ihm eingeplant wird.
 */
export function proposeSprint(
  candidates: PlanCandidate[],
  doneIds: ReadonlySet<string>,
  capacity: Capacity,
): SprintProposal {
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const scored = candidates
    .map((candidate) => ({
      candidate,
      score: scoreOf(candidate, !!candidate.followUpOf && doneIds.has(candidate.followUpOf)),
      hours: candidate.effortHours ?? DEFAULT_ORDER_HOURS,
    }))
    .sort((a, b) => Number(b.candidate.carryOver) - Number(a.candidate.carryOver) || b.score - a.score);

  const chosen: typeof scored = [];
  const skipped = new Map<string, string>();
  let hours = 0;
  let tokens = 0;
  const chosenIds = new Set<string>();
  // Mehrere Durchläufe, damit ein Folgeauftrag nach seinem (später bewerteten) Vorgänger noch Platz findet.
  for (let pass = 0; pass < 3; pass += 1) {
    for (const entry of scored) {
      const { candidate } = entry;
      if (chosenIds.has(candidate.id)) continue;
      const predecessor = candidate.followUpOf;
      if (predecessor && !doneIds.has(predecessor) && !chosenIds.has(predecessor)) {
        skipped.set(
          candidate.id,
          byId.has(predecessor) ? 'wartet auf seinen Vorgänger' : 'Vorgänger noch nicht erledigt',
        );
        continue;
      }
      const fitsHours = hours + entry.hours <= capacity.hours || chosen.length === 0;
      const fitsTokens = capacity.tokens === null || tokens + (candidate.tokenEstimate ?? 0) <= capacity.tokens;
      if (!candidate.carryOver && !(fitsHours && fitsTokens)) {
        skipped.set(candidate.id, 'Kapazität erreicht');
        continue;
      }
      chosen.push(entry);
      chosenIds.add(candidate.id);
      skipped.delete(candidate.id);
      hours += entry.hours;
      tokens += candidate.tokenEstimate ?? 0;
    }
  }

  // Nur übernommene Aufträge ergäben keinen Sprint (der Autopilot startet ihn dann nicht): Passt kein neuer Auftrag
  // mehr in die Kapazität, kommt trotzdem der am besten bewertete dazu, dessen Vorgänger erledigt ist.
  if (!chosen.some((entry) => !entry.candidate.carryOver)) {
    const next = scored.find(
      ({ candidate }) =>
        !candidate.carryOver &&
        (!candidate.followUpOf || doneIds.has(candidate.followUpOf) || chosenIds.has(candidate.followUpOf)),
    );
    if (next) {
      chosen.push(next);
      chosenIds.add(next.candidate.id);
      skipped.delete(next.candidate.id);
      hours += next.hours;
      tokens += next.candidate.tokenEstimate ?? 0;
    }
  }

  // Reihenfolge: nach Bewertung; Vorgänger vor Folgeauftrag; gleiche Dateien direkt hintereinander.
  const ordered: typeof chosen = [];
  const placed = new Set<string>();
  const place = (entry: (typeof chosen)[number]): void => {
    if (placed.has(entry.candidate.id)) return;
    const predecessor = chosen.find((other) => other.candidate.id === entry.candidate.followUpOf);
    if (predecessor) place(predecessor);
    placed.add(entry.candidate.id);
    ordered.push(entry);
    for (const sibling of chosen) {
      if (
        !placed.has(sibling.candidate.id) &&
        sibling.candidate.files.some((file) => entry.candidate.files.includes(file))
      )
        place(sibling);
    }
  };
  for (const entry of chosen) place(entry);

  const rankOf = new Map(ordered.map((entry, index) => [entry.candidate.id, index + 1]));
  const items: PlannedItem[] = scored.map(({ candidate, score, hours: itemHours }) => {
    const predecessorTitle = candidate.followUpOf ? (byId.get(candidate.followUpOf)?.title ?? null) : null;
    const selected = chosenIds.has(candidate.id);
    const reason = reasonOf(candidate, predecessorTitle);
    return {
      id: candidate.id,
      title: candidate.title,
      score,
      reason: selected ? reason : `${reason} – nicht eingeplant: ${skipped.get(candidate.id) ?? 'Kapazität erreicht'}`,
      hours: itemHours,
      tokens: candidate.tokenEstimate,
      selected,
      rank: rankOf.get(candidate.id) ?? null,
      carryOver: candidate.carryOver,
    };
  });
  items.sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9) || b.score - a.score);
  return { capacity, items, totals: { hours: Math.round(hours * 10) / 10, tokens } };
}

export interface RoadmapSprint {
  items: PlannedItem[];
  totals: { hours: number; tokens: number };
}

/**
 * Roadmap: die nächsten `count` Sprints nacheinander vorausberechnen. Eingeplante Aufträge gelten für die
 * folgenden Sprints als erledigt (Folgeaufträge rücken nach) und erscheinen nicht erneut. Rein rechnerisch.
 */
export function planRoadmap(
  candidates: PlanCandidate[],
  doneIds: ReadonlySet<string>,
  capacity: Capacity,
  count = 3,
): RoadmapSprint[] {
  const sprints: RoadmapSprint[] = [];
  const done = new Set(doneIds);
  let remaining = candidates;
  while (sprints.length < count && remaining.length) {
    const proposal = proposeSprint(remaining, done, capacity);
    const items = proposal.items.filter((item) => item.selected);
    if (!items.length) break;
    sprints.push({ items, totals: proposal.totals });
    for (const item of items) done.add(item.id);
    // Übernommene „Aktion notwendig“-Aufträge gehören nur in den ersten Sprint.
    remaining = remaining
      .filter((candidate) => !done.has(candidate.id))
      .map((candidate) => ({ ...candidate, carryOver: false }));
  }
  return sprints;
}
