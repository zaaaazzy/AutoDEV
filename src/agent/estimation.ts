import { logged } from '../core/log.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runCommand } from '../core/command.js';
import { runInSandbox, sandboxMode, usesSandbox } from '../core/sandbox.js';
import { projectSandbox } from '../runner/test-sandbox.js';
import { agentEnvironment, buildInvocation } from '../runner/runner-prompts.js';
import { containsUntrusted, UNTRUSTED_HINT } from '../runner/hoster.js';
import { restrictedSystemCommand } from './system-agents.js';
import type { Pool } from 'pg';
import { loadProjectContext } from '../core/project-context.js';
import { DEFAULT_OLLAMA_URL, patientFetch, requestOllamaChat, resolveModel } from './ollama-client.js';
import { type AreaBucket, areaBucket, median } from '../core/sprint-planner.js';

export interface Estimate {
  effortHours: number | null;
  tokenEstimate: number | null;
  benefit: number | null;
  cost: number | null;
}

const number = (value: unknown, min: number, max: number): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : null;

const round = (value: number | null): number | null => (value === null ? null : Math.round(value));

// Nur „Schätzung“, „Schätzung (…)“ oder „Schätzung:“ – nicht etwa „### Schätzungsgrundlage“ in den Hinweisen.
const ESTIMATE_HEADING = /\n#{1,4}[ \t]*Schätzung[ \t]*(?:\([^\n]*\)|:)?[ \t]*(?=\n|$)/gi;

function toEstimate(json: string): Estimate | null {
  try {
    const raw = JSON.parse(json) as Record<string, unknown>;
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

/** Splits the author's answer into the requirement text and the estimate from its last "Schätzung" section. */
export function splitEstimate(output: string): { requirement: string; estimate: Estimate | null } {
  const section = [...output.matchAll(ESTIMATE_HEADING)].at(-1);
  if (!section) return { requirement: output.trim(), estimate: null };
  return {
    requirement: output.slice(0, section.index).trim(),
    estimate: parseEstimate(output.slice(section.index + section[0].length)),
  };
}

/**
 * Reads a bare JSON object (the quick estimation answer has no "Schätzung" heading). CLI output may carry
 * banners or log lines with braces, so flat objects are tried from the last one backwards first.
 */
export function parseEstimate(output: string): Estimate | null {
  const flat = output.match(/\{[^{}]*\}/g) ?? [];
  for (const candidate of flat.reverse()) {
    const estimate = toEstimate(candidate);
    if (estimate) return estimate;
  }
  const json = /\{[\s\S]*\}/.exec(output);
  return json ? toEstimate(json[0]) : null;
}

/** Art eines Auftrags bzw. einer Idee für den Vergleich; ohne Angabe gilt `feature`. */
export type OrderKind = 'feature' | 'bug';

export const orderKind = (value: string | null | undefined): OrderKind => (value === 'bug' ? 'bug' : 'feature');

/**
 * Ist-Werte erledigter Aufträge gleicher Kategorie und Art: Median der Agent-Laufzeit (Stunden) und der Tokens.
 * `areas` nennt die Bereichsgruppe, wenn die engste Gruppe (gleiche Anzahl betroffener Bereiche) genügend Aufträge hat;
 * sonst null (Median der ganzen Kategorie).
 */
export interface ActualReference {
  category: string | null;
  kind: OrderKind;
  areas: AreaBucket | null;
  count: number;
  medianHours: number;
  medianTokens: number;
}

/** So viele erledigte Aufträge braucht die engste Gruppe (Kategorie, Art, Bereichsanzahl); sonst gilt die Kategorie. */
export const MIN_REFERENCE_ORDERS = 5;
/** Höchstens so viele jüngste erledigte Aufträge fließen in die Referenz ein. */
const REFERENCE_LIMIT = 200;

type ReferenceRow = { hours: string | number | null; tokens: string | number | null; description: string | null };

/**
 * Lernende Schätzung: Median-Ist-Werte erledigter Aufträge derselben Kategorie (ohne Kategorie: Aufträge ohne
 * Kategorie) und derselben Art. Gibt es mindestens `MIN_REFERENCE_ORDERS` mit derselben Bereichsanzahl
 * (`areaBucket` der Beschreibung), zählt nur diese Gruppe; sonst alle Aufträge der Kategorie ohne Bereichsfilter.
 * Die Art gilt immer: Eine Idee ohne Art wird nur mit `feature`-Aufträgen verglichen. null, solange es keine solchen
 * Aufträge mit gemessenem Verbrauch gibt.
 */
export async function loadActualReference(
  pool: Pool,
  project: string,
  category: string | null,
  options: { kind?: string | null; areas?: AreaBucket | null } = {},
): Promise<ActualReference | null> {
  const kind = orderKind(options.kind);
  const rows = (
    await pool.query<ReferenceRow>(
      `SELECT SUM(st.duration_ms) / 3600000.0 AS hours, SUM(st.tokens) AS tokens, d.description
         FROM development_items d
         JOIN agent_runs r ON r.development_id = d.id
         JOIN agent_run_steps st ON st.run_id = r.id
        WHERE d.project_slug = $1 AND d.status = 'done' AND d.category IS NOT DISTINCT FROM $2 AND d.kind = $3
        GROUP BY d.id
       HAVING SUM(st.tokens) > 0 OR SUM(st.duration_ms) > 0
        ORDER BY d.completed_at DESC NULLS LAST
        LIMIT ${REFERENCE_LIMIT}`,
      [project, category, kind],
    )
  ).rows;
  if (!rows.length) return null;
  const narrow = options.areas ? rows.filter((row) => areaBucket(row.description ?? '') === options.areas) : [];
  const group = narrow.length >= MIN_REFERENCE_ORDERS ? narrow : rows;
  return {
    category,
    kind,
    areas: group === narrow ? (options.areas ?? null) : null,
    count: group.length,
    medianHours: Math.round((median(group.map((row) => Number(row.hours ?? 0))) ?? 0) * 10) / 10,
    medianTokens: Math.round(median(group.map((row) => Number(row.tokens ?? 0))) ?? 0),
  };
}

const AREA_LABELS: Record<AreaBucket, string> = {
  '1': '1 betroffener Bereich',
  '2-3': '2–3 betroffene Bereiche',
  '4+': '4 und mehr betroffene Bereiche',
};

/**
 * Einheit der Schätzung für beide Prompts (Schnellschätzung und Auftragsautor): gemessen und eingeplant wird die
 * Laufzeit der Agents, nicht die Arbeitszeit eines Menschen.
 */
export const ESTIMATE_UNIT_HINT =
  'effortHours: erwartete Agent-Laufzeit in Stunden (Summe aller Agent-Schritte des Auftrags, z. B. 0.3), ' +
  'nicht die Arbeitszeit eines Menschen; tokenEstimate: Tokens aller Agent-Läufe des Auftrags.';

/** Abschnitt für den Autor-Prompt: die Schätzung an echten Ist-Werten ausrichten. */
export function referenceSection(reference: ActualReference): string {
  const parts = [
    reference.category ? `der Kategorie „${reference.category}“` : 'ohne Kategorie',
    `Art „${reference.kind}“`,
    reference.areas ? AREA_LABELS[reference.areas] : 'alle Bereichsgrößen',
  ];
  const scope = parts.join(', ');
  return [
    '## Ist-Werte ähnlicher erledigter Aufträge (für die Schätzung)',
    `${reference.count} erledigte Aufträge ${scope}: Median ${String(reference.medianHours).replace('.', ',')} h ` +
      `Agent-Laufzeit und ${reference.medianTokens} Tokens je Auftrag.`,
    'Richte effortHours und tokenEstimate an diesen Werten aus; weiche nur ab, wenn der Auftrag deutlich größer ' +
      'oder kleiner ist, und begründe das kurz in den technischen Hinweisen.',
  ].join('\n');
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

/**
 * Uses the external CLI chosen for the author role. It only has to answer, so by default it gets no permission flags,
 * and it always runs in its own empty temp folder: idea texts come from users and must not be able to touch files.
 */
async function estimateWithCommand(
  command: string[],
  prompt: string,
  project: string,
  sandboxed: boolean,
): Promise<Estimate | null> {
  const cwd = await mkdtemp(join(tmpdir(), 'dev-log-estimate-'));
  try {
    const invocation = buildInvocation(command, prompt);
    const options = { timeoutMs: ESTIMATE_TIMEOUT_MS * 2, env: agentEnvironment() };
    // Docker-Sandbox (Standard): auch die Schätzung läuft im Container, mit dem leeren Ordner nur lesend.
    const result = sandboxed
      ? await runInSandbox(invocation, cwd, {
          ...options,
          environment: options.env,
          runId: `estimate-${randomUUID().slice(0, 8)}`,
          project,
          readOnly: true,
        })
      : await runCommand(invocation, cwd, options);
    return result.exitCode === 0 ? parseEstimate(result.output) : null;
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

/** Schnellschätzung speichern: füllt nur leere Felder; eine neue Stunden- oder Token-Schätzung gilt als `quick`. */
export const QUICK_ESTIMATE_SQL = `
  UPDATE ideation_items SET effort_hours = COALESCE(effort_hours, $2), token_estimate = COALESCE(token_estimate, $3),
        benefit = COALESCE(benefit, $4), cost = COALESCE(cost, $5),
        estimate_source = CASE WHEN estimate_source IS NULL AND effort_hours IS NULL AND token_estimate IS NULL
                                 AND ($2::float8 IS NOT NULL OR $3::bigint IS NOT NULL) THEN 'quick'
                               ELSE estimate_source END
  WHERE id = $1
`;

/**
 * Estimates ideas that have no values yet; values entered by users are kept. Failures are noted once, not retried.
 * A passed estimator always wins; otherwise the CLI chosen in the dashboard or the local model is used.
 */
export async function estimateNewIdeas(
  pool: Pool,
  project: string,
  estimate?: (prompt: string) => Promise<Estimate | null>,
): Promise<number> {
  const ideas = (
    await pool.query<{ id: string; title: string; description: string; category: string | null; kind?: string }>(
      `SELECT id, title, description, category, kind FROM ideation_items
        WHERE project_slug = $1 AND status IN ('idea', 'considering', 'review', 'requested') AND agent_note IS NULL
          AND effort_hours IS NULL AND token_estimate IS NULL AND benefit IS NULL AND cost IS NULL
        ORDER BY created_at LIMIT 5`,
      [project],
    )
  ).rows;
  if (!ideas.length) return 0;
  const context = (await loadProjectContext(pool, project)).slice(0, 600);
  const external = estimate ? null : await restrictedSystemCommand(pool, 'author');
  const sandboxed = external ? usesSandbox(sandboxMode(await projectSandbox(pool, project))) : false;
  const run =
    estimate ??
    (external ? (prompt: string) => estimateWithCommand(external, prompt, project, sandboxed) : quickEstimate);
  // Vergleichsgruppe je Kategorie, Art und Bereichsanzahl; gleiche Gruppen nur einmal laden.
  const references = new Map<string, ActualReference | null>();
  for (const idea of ideas) {
    const group = { kind: orderKind(idea.kind), areas: areaBucket(idea.description) };
    const key = JSON.stringify([idea.category, group.kind, group.areas]);
    if (!references.has(key))
      references.set(
        key,
        await loadActualReference(pool, project, idea.category, group).catch(logged('estimation', null)),
      );
    const reference = references.get(key);
    const prompt = [
      'Schätze Aufwand eines Entwicklungsauftrags. Antworte nur mit einem JSON-Objekt:',
      '{"effortHours": Agent-Stunden, "tokenEstimate": Tokens aller KI-Agent-Läufe, "benefit": 0-10, "cost": 0-10}',
      ESTIMATE_UNIT_HINT,
      reference ? referenceSection(reference) : '',
      context ? `Projekt: ${context}` : '',
      `Titel: ${idea.title}\n${idea.description.slice(0, 1500)}`,
      // Aus GitHub übernommene Ideen: fremder Text, nur Daten.
      containsUntrusted(idea.description) ? UNTRUSTED_HINT : '',
    ]
      .filter(Boolean)
      .join('\n\n');
    const result = await run(prompt).catch(logged('estimation', null));
    if (!result) {
      await pool.query(
        `UPDATE ideation_items SET agent_note = 'Aufwand konnte nicht geschätzt werden – bitte manuell ergänzen.' WHERE id = $1 AND agent_note IS NULL`,
        [idea.id],
      );
      continue;
    }
    await pool.query(QUICK_ESTIMATE_SQL, [
      idea.id,
      result.effortHours,
      result.tokenEstimate,
      result.benefit,
      result.cost,
    ]);
  }
  return ideas.length;
}
