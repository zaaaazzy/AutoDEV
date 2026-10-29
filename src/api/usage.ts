import type { Router } from 'express';
import type { Pool } from 'pg';
import { access } from './access.js';
import { parseProjectSlug } from '../core/validation.js';
import { realFailureSql } from '../core/interrupted-steps.js';

/** Bezeichnungen der Agents außerhalb des Auftrags-Workflows (Tabelle agent_usage). */
const SYSTEM_ROLES: Record<string, string> = {
  assistant: 'Dashboard-Assistent',
  author: 'Auftragsautor (Ideen)',
  bug_reviewer: 'Bug-Wächter (Planung)',
  analyst: 'Problemanalyse',
  visionary: 'Visionär',
};

interface Usage {
  tokens: number;
  hours: number;
  costUsd: number;
}

const usage = (row: { tokens: string | null; ms: string | null; cost: string | null }): Usage => ({
  tokens: Number(row.tokens ?? 0),
  hours: Math.round((Number(row.ms ?? 0) / 3_600_000) * 100) / 100,
  costUsd: Math.round(Number(row.cost ?? 0) * 100) / 100,
});

/**
 * Verbrauch eines Projekts: nach Bereich, nach Art (Auftrag, Bug, Dashboard, Planung), Schätzung gegen tatsächlichen
 * Aufwand je Auftrag und die Agents im Vergleich.
 */
export async function collectUsage(pool: Pool, slug: string): Promise<Record<string, unknown>> {
  const [orders, system, agents] = await Promise.all([
    pool.query<{
      id: string;
      title: string;
      kind: string;
      category: string | null;
      status: string;
      estHours: string | null;
      estTokens: string | null;
      tokens: string | null;
      ms: string | null;
      cost: string | null;
      runs: string;
    }>(
      `SELECT d.id, d.title, d.kind, d.category, d.status,
              d.effort_hours AS "estHours", d.token_estimate AS "estTokens",
              SUM(st.tokens) AS tokens, SUM(st.duration_ms) AS ms, SUM(st.cost_usd) AS cost,
              COUNT(DISTINCT r.id) AS runs
         FROM development_items d
         LEFT JOIN agent_runs r ON r.development_id = d.id
         LEFT JOIN agent_run_steps st ON st.run_id = r.id
        WHERE d.project_slug = $1
        GROUP BY d.id
        ORDER BY d.created_at DESC`,
      [slug],
    ),
    pool.query<{ role: string; count: string; failed: string; tokens: string; ms: string; cost: string }>(
      `SELECT role, COUNT(*) AS count, COUNT(*) FILTER (WHERE NOT success) AS failed,
              SUM(tokens) AS tokens, SUM(duration_ms) AS ms, SUM(cost_usd) AS cost
         FROM agent_usage WHERE project_slug = $1 GROUP BY role`,
      [slug],
    ),
    pool.query<{ agent: string; count: string; failed: string; tokens: string; ms: string; cost: string }>(
      `SELECT st.agent_name AS agent, COUNT(*) AS count, COUNT(*) FILTER (WHERE ${realFailureSql('st')}) AS failed,
              SUM(st.tokens) AS tokens, SUM(st.duration_ms) AS ms, SUM(st.cost_usd) AS cost
         FROM agent_run_steps st JOIN agent_runs r ON r.id = st.run_id
        WHERE r.project_slug = $1 AND st.status IN ('passed', 'failed')
        GROUP BY st.agent_name`,
      [slug],
    ),
  ]);

  const orderRows = orders.rows.map((row) => ({
    id: row.id,
    title: row.title,
    kind: row.kind,
    category: row.category,
    status: row.status,
    runs: Number(row.runs),
    estimate: {
      hours: row.estHours === null ? null : Number(row.estHours),
      tokens: row.estTokens === null ? null : Number(row.estTokens),
    },
    actual: usage(row),
  }));

  const group = (key: (row: (typeof orderRows)[number]) => string) => {
    const result = new Map<
      string,
      { key: string; count: number; actual: Usage; estimate: { hours: number; tokens: number } }
    >();
    for (const row of orderRows) {
      const entry = result.get(key(row)) ?? {
        key: key(row),
        count: 0,
        actual: { tokens: 0, hours: 0, costUsd: 0 },
        estimate: { hours: 0, tokens: 0 },
      };
      entry.count += 1;
      entry.actual.tokens += row.actual.tokens;
      entry.actual.hours = Math.round((entry.actual.hours + row.actual.hours) * 100) / 100;
      entry.actual.costUsd = Math.round((entry.actual.costUsd + row.actual.costUsd) * 100) / 100;
      entry.estimate.hours += row.estimate.hours ?? 0;
      entry.estimate.tokens += row.estimate.tokens ?? 0;
      result.set(key(row), entry);
    }
    return [...result.values()].sort((a, b) => b.actual.tokens - a.actual.tokens);
  };

  const byKind = group((row) => (row.kind === 'bug' ? 'bug' : 'order'));
  const chat = system.rows.filter((row) => row.role === 'assistant');
  const planning = system.rows.filter((row) => row.role !== 'assistant');
  const systemEntry = (key: string, rows: typeof system.rows) => ({
    key,
    count: rows.reduce((sum, row) => sum + Number(row.count), 0),
    actual: usage({
      tokens: String(rows.reduce((sum, row) => sum + Number(row.tokens), 0)),
      ms: String(rows.reduce((sum, row) => sum + Number(row.ms), 0)),
      cost: String(rows.reduce((sum, row) => sum + Number(row.cost), 0)),
    }),
    estimate: { hours: 0, tokens: 0 },
  });
  if (chat.length) byKind.push(systemEntry('dashboard', chat));
  if (planning.length) byKind.push(systemEntry('planning', planning));

  const agentRows = [
    ...agents.rows.map((row) => ({ ...row, source: 'workflow' })),
    ...system.rows.map((row) => ({ ...row, agent: SYSTEM_ROLES[row.role] ?? row.role, source: 'system' })),
  ].map((row) => {
    const count = Number(row.count);
    const actual = usage(row);
    return {
      agent: row.agent,
      source: row.source,
      count,
      failed: Number(row.failed),
      successRate: count ? Math.round(((count - Number(row.failed)) / count) * 100) : null,
      actual,
      avgTokens: count ? Math.round(actual.tokens / count) : 0,
      avgSeconds: count ? Math.round(Number(row.ms) / count / 1000) : 0,
    };
  });
  const totalTokens = agentRows.reduce((sum, row) => sum + row.actual.tokens, 0);

  const estimated = orderRows.filter((row) => row.estimate.tokens && row.actual.tokens);
  return {
    routing: await routingSavings(pool, slug),
    totals: {
      tokens: totalTokens,
      hours: Math.round(agentRows.reduce((sum, row) => sum + row.actual.hours, 0) * 100) / 100,
      costUsd: Math.round(agentRows.reduce((sum, row) => sum + row.actual.costUsd, 0) * 100) / 100,
      estimateTokens: estimated.reduce((sum, row) => sum + (row.estimate.tokens ?? 0), 0),
      estimateActualTokens: estimated.reduce((sum, row) => sum + row.actual.tokens, 0),
    },
    byCategory: group((row) => row.category ?? 'none'),
    byKind,
    orders: orderRows,
    agents: agentRows
      .map((row) => ({ ...row, share: totalTokens ? Math.round((row.actual.tokens / totalTokens) * 1000) / 10 : 0 }))
      .sort((a, b) => b.actual.tokens - a.actual.tokens),
  };
}

/**
 * Ist-Verbrauch der erledigten Aufträge je abgeschlossenem Sprint (neueste zuerst): Laufzeit und Tokens aller
 * Agent-Schritte – Grundlage der Sprint-Kapazität statt der Schätzungen.
 */
export async function completedSprintUsage(pool: Pool, slug: string, limit = 3): Promise<Usage[]> {
  const rows = await pool.query<{ tokens: string | null; ms: string | null; cost: string | null }>(
    `SELECT SUM(st.tokens) FILTER (WHERE d.status = 'done') AS tokens,
            SUM(st.duration_ms) FILTER (WHERE d.status = 'done') AS ms,
            SUM(st.cost_usd) FILTER (WHERE d.status = 'done') AS cost
       FROM sprints s
       LEFT JOIN development_items d ON d.sprint_id = s.id
       LEFT JOIN agent_runs r ON r.development_id = d.id
       LEFT JOIN agent_run_steps st ON st.run_id = r.id
      WHERE s.project_slug = $1 AND s.status = 'completed'
      GROUP BY s.id
      ORDER BY COALESCE(s.end_date, s.created_at::date) DESC, s.created_at DESC
      LIMIT $2`,
    [slug, limit],
  );
  return rows.rows.map(usage);
}

/**
 * Durchschnittspreis je Token aus den gemessenen Kosten (erst das Projekt, sonst alle Projekte); null, solange
 * nichts mit Kosten gemessen wurde (z. B. nur lokale Modelle).
 */
export async function tokenPriceUsd(pool: Pool, slug: string): Promise<number | null> {
  for (const project of [slug, null]) {
    const row = (
      await pool.query<{ cost: string | null; tokens: string | null }>(
        `SELECT SUM(cost) AS cost, SUM(tokens) AS tokens FROM (
           SELECT st.cost_usd AS cost, st.tokens FROM agent_run_steps st JOIN agent_runs r ON r.id = st.run_id
            WHERE ($1::text IS NULL OR r.project_slug = $1) AND st.cost_usd > 0 AND st.tokens > 0
           UNION ALL
           SELECT cost_usd, tokens FROM agent_usage
            WHERE ($1::text IS NULL OR project_slug = $1) AND cost_usd > 0 AND tokens > 0
         ) measured`,
        [project],
      )
    ).rows[0];
    const tokens = Number(row?.tokens ?? 0);
    if (tokens > 0) return Number(row?.cost ?? 0) / tokens;
  }
  return null;
}

/** Geschätzte Kosten in USD für eine Tokenmenge (auf Cent gerundet); null ohne Preis. */
export function costOfTokens(tokens: number, pricePerToken: number | null): number | null {
  return pricePerToken === null ? null : Math.round(tokens * pricePerToken * 100) / 100;
}

/**
 * Verbrauch je Modell und geschätzte Ersparnis durch das Routing: Tokens, die das Routing lokal (0 USD) statt über
 * ein kostenpflichtiges Modell laufen ließ, bewertet mit dem gemessenen Durchschnittspreis je Token.
 */
export async function routingSavings(pool: Pool, slug: string): Promise<Record<string, unknown>> {
  const [models, routed, price] = await Promise.all([
    pool.query<{ model: string; count: string; tokens: string; cost: string; routed: string }>(
      `SELECT COALESCE(st.model, 'unbekannt') AS model, COUNT(*) AS count, COALESCE(SUM(st.tokens), 0) AS tokens,
              COALESCE(SUM(st.cost_usd), 0) AS cost, COUNT(*) FILTER (WHERE st.routing_rule IS NOT NULL) AS routed
         FROM agent_run_steps st JOIN agent_runs r ON r.id = st.run_id
        WHERE r.project_slug = $1 AND st.status IN ('passed', 'failed')
        GROUP BY 1 ORDER BY SUM(st.tokens) DESC NULLS LAST LIMIT 20`,
      [slug],
    ),
    pool.query<{ steps: string; localTokens: string }>(
      `SELECT COUNT(*) AS steps, COALESCE(SUM(st.tokens) FILTER (WHERE st.cost_usd = 0), 0) AS "localTokens"
         FROM agent_run_steps st JOIN agent_runs r ON r.id = st.run_id
        WHERE r.project_slug = $1 AND st.routing_rule IS NOT NULL`,
      [slug],
    ),
    tokenPriceUsd(pool, slug),
  ]);
  const localTokens = Number(routed.rows[0]?.localTokens ?? 0);
  return {
    routedSteps: Number(routed.rows[0]?.steps ?? 0),
    localTokens,
    savedUsd: costOfTokens(localTokens, price),
    byModel: models.rows.map((row) => ({
      model: row.model,
      count: Number(row.count),
      routed: Number(row.routed),
      tokens: Number(row.tokens),
      costUsd: Math.round(Number(row.cost) * 100) / 100,
    })),
  };
}

/** Prompt-Protokoll der Systemagents (neueste zuerst), optional nur einer Rolle. */
export async function loadPromptLog(pool: Pool, slug: string, role: string | null, limit = 20) {
  return (
    await pool.query<{ id: string; role: string; prompt: string; tokens: string; createdAt: string; success: boolean }>(
      `SELECT id::text, role, prompt, tokens::text, created_at AS "createdAt", success FROM agent_usage
        WHERE project_slug = $1 AND prompt IS NOT NULL AND ($2::text IS NULL OR role = $2)
        ORDER BY created_at DESC LIMIT $3`,
      [slug, role, limit],
    )
  ).rows.map((row) => ({ ...row, agent: SYSTEM_ROLES[row.role] ?? row.role, tokens: Number(row.tokens) }));
}

export function registerUsageRoutes(app: Router, pool: Pool): void {
  app.get('/projects/:slug/usage', access({ tenant: 'project' }), async (request, response, next) => {
    try {
      const slug = parseProjectSlug(request.params.slug ?? '');
      if (!slug) return void response.status(400).json({ message: 'Ungültiges Projekt.' });
      response.json(await collectUsage(pool, slug));
    } catch (error) {
      next(error);
    }
  });

  app.get('/projects/:slug/usage/prompts', access({ tenant: 'project' }), async (request, response) => {
    const slug = parseProjectSlug(request.params.slug ?? '');
    if (!slug) return void response.status(400).json({ message: 'Ungültiges Projekt.' });
    const role =
      typeof request.query.role === 'string' && /^[a-z_]{1,40}$/.test(request.query.role) ? request.query.role : null;
    response.json({ prompts: await loadPromptLog(pool, slug, role) });
  });
}
