export interface Estimate {
  effortHours: number | null;
  tokenEstimate: number | null;
  benefit: number | null;
  cost: number | null;
}

const number = (value: unknown, min: number, max: number): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : null;

const round = (value: number | null): number | null => (value === null ? null : Math.round(value));

const ESTIMATE_SECTION = /\n#{1,4}\s*Schätzung[^\n]*\n([\s\S]*)$/i;

/** Splits the author's answer into the requirement text and the estimate from its "Schätzung" section. */
export function splitEstimate(output: string): { requirement: string; estimate: Estimate | null } {
  const section = ESTIMATE_SECTION.exec(output);
  if (!section) return { requirement: output.trim(), estimate: null };
  const requirement = output.slice(0, section.index).trim();
  const json = /\{[\s\S]*\}/.exec(section[1] ?? '');
  if (!json) return { requirement, estimate: null };
  try {
    const raw = JSON.parse(json[0]) as Record<string, unknown>;
    const estimate = {
      effortHours: number(raw.effortHours, 0, 10_000),
      tokenEstimate: round(number(raw.tokenEstimate, 0, 1_000_000_000)),
      benefit: round(number(raw.benefit, 0, 10)),
      cost: round(number(raw.cost, 0, 10)),
    };
    return { requirement, estimate: Object.values(estimate).some((value) => value !== null) ? estimate : null };
  } catch {
    return { requirement, estimate: null };
  }
}
