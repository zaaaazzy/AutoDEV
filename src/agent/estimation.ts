import { tmpdir } from 'node:os';
import { runCommand } from '../core/command.js';
import { agentEnvironment, buildInvocation } from '../runner/runner-prompts.js';
import { systemCommand } from './system-agents.js';
import type { Pool } from 'pg';
import { loadProjectContext } from '../core/project-context.js';
import { DEFAULT_OLLAMA_URL, patientFetch, requestOllamaChat, resolveModel } from './ollama-client.js';

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

/** Reads a bare JSON object (the quick estimation answer has no "Schätzung" heading). */
export function parseEstimate(output: string): Estimate | null {
  const json = /\{[\s\S]*\}/.exec(output);
  return json ? splitEstimate(`\n## Schätzung\n${json[0]}`).estimate : null;
}

const ESTIMATE_TIMEOUT_MS = 90_000;

/** One tool-free model call: far faster than a full agent run, so new ideas get their estimate within seconds. */
export async function quickEstimate(prompt: string, fetchImpl: typeof fetch = patientFetch): Promise<Estimate | null> {
  const baseUrl = (process.env.DEV_LOG_OLLAMA_URL ?? DEFAULT_OLLAMA_URL).replace(/\/$/, '');
  const response = await requestOllamaChat(
    fetchImpl,
    baseUrl,
    {
      model: resolveModel('author'),
      messages: [{ role: 'user', content: prompt }],
      stream: false,
      think: false,
      format: 'json',
      keep_alive: process.env.DEV_LOG_OLLAMA_KEEP_ALIVE?.trim() || '30m',
      options: { num_ctx: 4096, num_predict: 120, temperature: 0.1 },
    },
    AbortSignal.timeout(ESTIMATE_TIMEOUT_MS),
  );
  if (!response.ok) return null;
  const body = (await response.json()) as { message?: { content?: string } };
  return parseEstimate(body.message?.content ?? '');
}

/** Uses the external CLI chosen for the author role; it runs in a temp folder because it only has to answer. */
async function estimateWithCommand(command: string[], prompt: string): Promise<Estimate | null> {
  const result = await runCommand(buildInvocation(command, prompt), tmpdir(), {
    timeoutMs: ESTIMATE_TIMEOUT_MS * 2,
    env: agentEnvironment(),
  });
  return result.exitCode === 0 ? parseEstimate(result.output) : null;
}

/** Estimates ideas that have no values yet; values entered by users are kept. Failures are noted once, not retried. */
export async function estimateNewIdeas(pool: Pool, project: string, estimate = quickEstimate): Promise<number> {
  const ideas = (
    await pool.query<{ id: string; title: string; description: string }>(
      `SELECT id, title, description FROM ideation_items
        WHERE project_slug = $1 AND status IN ('idea', 'considering', 'review', 'requested') AND agent_note IS NULL
          AND effort_hours IS NULL AND token_estimate IS NULL AND benefit IS NULL AND cost IS NULL
        ORDER BY created_at LIMIT 5`,
      [project],
    )
  ).rows;
  if (!ideas.length) return 0;
  const context = (await loadProjectContext(pool, project)).slice(0, 600);
  const external = await systemCommand(pool, 'author');
  for (const idea of ideas) {
    const prompt = [
      'Schätze Aufwand eines Entwicklungsauftrags. Antworte nur mit einem JSON-Objekt:',
      '{"effortHours": Stunden, "tokenEstimate": Tokens aller KI-Agent-Läufe, "benefit": 0-10, "cost": 0-10}',
      context ? `Projekt: ${context}` : '',
      `Titel: ${idea.title}\n${idea.description.slice(0, 1500)}`,
    ]
      .filter(Boolean)
      .join('\n\n');
    const result = await (external ? estimateWithCommand(external, prompt) : estimate(prompt)).catch(() => null);
    if (!result) {
      await pool.query(
        `UPDATE ideation_items SET agent_note = 'Aufwand konnte nicht geschätzt werden – bitte manuell ergänzen.' WHERE id = $1 AND agent_note IS NULL`,
        [idea.id],
      );
      continue;
    }
    await pool.query(
      `UPDATE ideation_items SET effort_hours = COALESCE(effort_hours, $2), token_estimate = COALESCE(token_estimate, $3),
              benefit = COALESCE(benefit, $4), cost = COALESCE(cost, $5) WHERE id = $1`,
      [idea.id, result.effortHours, result.tokenEstimate, result.benefit, result.cost],
    );
  }
  return ideas.length;
}
