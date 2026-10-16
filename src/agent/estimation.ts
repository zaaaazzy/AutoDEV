import type { Pool } from 'pg';
import type { CommandExecutor } from '../core/command.js';
import { isShuttingDown } from '../core/shutdown.js';
import { runAuthorAgent } from './requirements.js';
import type { RunnerOptions } from '../runner/runner.js';

interface Estimate {
  effortHours: number | null;
  tokenEstimate: number | null;
  benefit: number | null;
  cost: number | null;
}

const number = (value: unknown, min: number, max: number): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : null;

const round = (value: number | null): number | null => (value === null ? null : Math.round(value));

/** Reads the first JSON object of an agent answer; invalid values become null. */
export function parseEstimate(output: string): Estimate | null {
  const match = /\{[\s\S]*\}/.exec(output);
  if (!match) return null;
  try {
    const raw = JSON.parse(match[0]) as Record<string, unknown>;
    const estimate = {
      effortHours: number(raw.effortHours, 0, 10_000),
      tokenEstimate: round(number(raw.tokenEstimate, 0, 1_000_000_000)),
      benefit: round(number(raw.benefit, 0, 10)),
      cost: round(number(raw.cost, 0, 10)),
    };
    return Object.values(estimate).some((value) => value !== null) ? estimate : null;
  } catch {
    return null;
  }
}

/** Lets the author agent estimate effort and cost of every new idea once; values entered by users are kept. */
export async function estimateIdeas(
  pool: Pool,
  options: Pick<RunnerOptions, 'project' | 'cwd' | 'timeoutMs'>,
  execute?: CommandExecutor,
): Promise<number> {
  const ideas = (
    await pool.query<{ id: string; title: string; description: string }>(
      `UPDATE ideation_items SET estimated_at = NOW()
      WHERE id IN (SELECT id FROM ideation_items WHERE project_slug = $1 AND estimated_at IS NULL
                    ORDER BY created_at LIMIT 5 FOR UPDATE SKIP LOCKED)
      RETURNING id, title, description`,
      [options.project],
    )
  ).rows;
  for (const idea of ideas) {
    console.info(`[idea ${idea.id}] Aufwand schätzen`);
    const { exitCode, output } = await runAuthorAgent(
      pool,
      options,
      () =>
        [
          'Schätze Aufwand und Kosten der folgenden Idee. Ändere nichts am Projekt.',
          `Titel: ${idea.title}\n${idea.description}`,
          'Antworte ausschließlich mit einem JSON-Objekt: {"effortHours": Stunden, "tokenEstimate": Tokens, "benefit": 0-10, "cost": 0-10}.',
        ].join('\n\n'),
      execute,
    );
    if (isShuttingDown()) {
      await pool.query(
        `UPDATE ideation_items SET estimated_at = NULL WHERE id = ANY($1::uuid[]) AND effort_hours IS NULL`,
        [ideas.map((item) => item.id)],
      );
      break;
    }
    const estimate = exitCode === 0 ? parseEstimate(output) : null;
    if (!estimate) {
      await pool.query(
        `UPDATE ideation_items SET agent_note = COALESCE(agent_note, 'Aufwand konnte nicht geschätzt werden – bitte manuell ergänzen.') WHERE id = $1`,
        [idea.id],
      );
      continue;
    }
    await pool.query(
      `UPDATE ideation_items SET effort_hours = COALESCE(effort_hours, $2), token_estimate = COALESCE(token_estimate, $3),
              benefit = COALESCE(benefit, $4), cost = COALESCE(cost, $5) WHERE id = $1`,
      [idea.id, estimate.effortHours, estimate.tokenEstimate, estimate.benefit, estimate.cost],
    );
  }
  return ideas.length;
}
