import { systemCommand } from './system-agents.js';
import type { Pool } from 'pg';
import { loadProjectContext, withProjectContext } from '../core/project-context.js';
import { isShuttingDown } from '../core/shutdown.js';
import { type CommandExecutor, redactOutput, runCommand } from '../core/command.js';
import { loadKnownBugs } from '../api/bugs.js';
import { splitEstimate } from './estimation.js';
import { runOllamaAgent } from './ollama-agent.js';
import { agentEnvironment, buildInvocation, defaultAgentCommand, type RunnerOptions } from '../runner/runner.js';

const MIN_REQUIREMENT_CHARS = 80;
const STALE_DRAFT_MINUTES = 45;

interface Idea {
  id: string;
  projectSlug: string;
  title: string;
  description: string;
  priority: string;
  comments: string[];
}

const FORMAT = [
  'Schreibe die Anforderung als Markdown mit genau diesen Abschnitten:',
  '## Ziel',
  '## Anforderungen (Liste)',
  '## Akzeptanzkriterien (Liste, prüfbar)',
  '## Technische Hinweise (betroffene Dateien/Module nach Prüfung des Projekts)',
  '## Diagramme (Mermaid-Codeblock, z. B. Ablauf oder ER-Diagramm, wenn hilfreich)',
  '## Abgrenzung',
  '## Schätzung (zuletzt, nur ein JSON-Objekt)',
  '{"effortHours": Stunden, "tokenEstimate": Tokens, "benefit": 0-10, "cost": 0-10}',
  'tokenEstimate: erwarteter Tokenverbrauch aller Agent-Läufe des Auftrags (Entwickler, Tester, Dokumentation), ' +
    'grob aus Anzahl und Größe der betroffenen Dateien berechnet; cost: Aufwand relativ 0 (gering) bis 10 (hoch).',
  'Erfinde keine Dateien. Beschreibe nur, was umgesetzt werden soll – ändere selbst nichts.',
].join('\n');

export function buildRequirementPrompt(instructions: string, idea: Idea, current?: string): string {
  return [
    'Du bist der Agent "Auftragsautor" und machst aus einer Idee eine umsetzbare Anforderung für einen Entwicklungsauftrag.',
    `## Anweisung\n${instructions || 'Formuliere präzise, umsetzbare Anforderungen.'}`,
    `## Idee\nTitel: ${idea.title}\nPriorität: ${idea.priority}\n${idea.description}`,
    ...(idea.comments.length
      ? [`## Kommentare zur Idee (berücksichtigen)\n${idea.comments.map((comment) => `- ${comment}`).join('\n')}`]
      : []),
    ...(current
      ? [
          `## Bisherige Anforderung\n${current}\nÜberarbeite sie unter Berücksichtigung der Kommentare und gib die vollständige neue Fassung aus.`,
        ]
      : []),
    FORMAT,
  ].join('\n\n');
}

/** Runs the project's agent of the given role (default: author) (own command, default command or local model) and returns its redacted output. */
export async function runAuthorAgent(
  pool: Pool,
  options: Pick<RunnerOptions, 'project' | 'cwd' | 'timeoutMs'>,
  buildPrompt: (instructions: string) => string,
  execute: CommandExecutor = runCommand,
  role = 'author',
  onProgress?: (message: string) => void,
): Promise<{ exitCode: number; output: string }> {
  const author = (
    await pool.query<{ instructions: string; command: string[] | null }>(
      `SELECT instructions, command FROM agents
      WHERE project_slug = $1 AND role = $2 AND enabled ORDER BY position LIMIT 1`,
      [options.project, role],
    )
  ).rows[0];
  const prompt = withProjectContext(
    await loadProjectContext(pool, options.project),
    buildPrompt(author?.instructions ?? ''),
  );
  const command = author?.command?.length
    ? author.command
    : ((await systemCommand(pool, role)) ?? defaultAgentCommand());
  try {
    const result = command
      ? await execute(buildInvocation(command, prompt), options.cwd, {
          timeoutMs: options.timeoutMs,
          env: agentEnvironment(),
        })
      : await runOllamaAgent({ prompt, role, cwd: options.cwd, timeoutMs: options.timeoutMs, onProgress });
    return { exitCode: result.exitCode, output: redactOutput(result.output, process.env).trim() };
  } catch (error) {
    return { exitCode: 1, output: error instanceof Error ? error.message : String(error) };
  }
}

/** Der Bug-Wächter prüft alle bisherigen Bugs auf Bezug zum Auftrag; ohne Antwort bleibt eine mechanische Liste. */
async function assessRisks(
  pool: Pool,
  options: Pick<RunnerOptions, 'project' | 'cwd' | 'timeoutMs'>,
  title: string,
  description: string,
  execute: CommandExecutor,
): Promise<string> {
  const bugs = await loadKnownBugs(pool, options.project, 60).catch(() => []);
  if (!bugs.length) return 'Keine bekannten Bugs im Projekt.';
  const list = bugs.map(
    (bug) =>
      `- [${bug.status === 'fixed' ? 'behoben' : 'offen'} / ${bug.severity}] ${bug.title}${bug.description ? ` – ${bug.description.slice(0, 200)}` : ''}${bug.fixNotes ? ` | Lösung: ${bug.fixNotes.slice(0, 300)}` : ''}`,
  );
  const { exitCode, output } = await runAuthorAgent(
    pool,
    options,
    (instructions) =>
      [
        'Du bist der Agent "Bug-Wächter". Prüfe, welche der bisherigen Bugs zum Kontext des Auftrags passen.',
        `## Anweisung\n${instructions}`,
        `## Auftrag\nTitel: ${title}\n${description}`,
        `## Alle bisherigen Bugs\n${list.join('\n')}`,
        'Antworte als Markdown-Liste nur mit den passenden Bugs: Bug, warum relevant, was nicht wiederholt werden darf. Passt keiner, schreibe "Keine relevanten Bugs." Ändere nichts.',
      ].join('\n\n'),
    execute,
    'bug_reviewer',
  );
  return exitCode === 0 && output
    ? output.slice(0, 6000)
    : `Bekannte Bugs (nicht gefiltert):\n${list.slice(0, 15).join('\n')}`;
}

/** Turns one requested idea into a backlog order. Sprint assignment stays a manual decision. */
export async function draftRequirements(
  pool: Pool,
  options: Pick<RunnerOptions, 'project' | 'cwd' | 'timeoutMs'>,
  execute: CommandExecutor = runCommand,
): Promise<number> {
  await pool.query(
    `UPDATE ideation_items SET status = 'requested', updated_at = NOW()
      WHERE project_slug = $1 AND status = 'drafting' AND updated_at < NOW() - ($2 || ' minutes')::interval`,
    [options.project, String(STALE_DRAFT_MINUTES)],
  );
  const claimed = await pool.query<Omit<Idea, 'comments'>>(
    `UPDATE ideation_items SET status = 'drafting', agent_note = NULL, updated_at = NOW()
      WHERE id = (SELECT id FROM ideation_items WHERE project_slug = $1 AND status = 'requested'
                   ORDER BY updated_at LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING id, project_slug AS "projectSlug", title, description, priority`,
    [options.project],
  );
  const claimedIdea = claimed.rows[0];
  if (!claimedIdea) {
    return 0;
  }
  const idea: Idea = {
    ...claimedIdea,
    comments: (
      await pool.query<{ line: string }>(
        `SELECT author || ': ' || body AS line FROM ideation_comments WHERE ideation_id = $1 ORDER BY created_at`,
        [claimedIdea.id],
      )
    ).rows.map((row) => row.line),
  };
  const existing = (
    await pool.query<{ id: string; description: string; status: string }>(
      `SELECT id, description, status FROM development_items WHERE ideation_id = $1 LIMIT 1`,
      [idea.id],
    )
  ).rows[0];
  console.info(`[idea ${idea.id}] Anforderung erstellen`);
  const { exitCode, output: rawOutput } = await runAuthorAgent(
    pool,
    options,
    (instructions) => buildRequirementPrompt(instructions, idea, existing?.description),
    execute,
  );
  if (isShuttingDown()) {
    await pool.query(`UPDATE ideation_items SET status = 'requested', updated_at = NOW() WHERE id = $1`, [idea.id]);
    return 0;
  }
  const { requirement: output, estimate } = splitEstimate(rawOutput);
  if (exitCode !== 0 || output.length < MIN_REQUIREMENT_CHARS) {
    await pool.query(
      `UPDATE ideation_items SET status = 'considering', agent_note = $2, updated_at = NOW() WHERE id = $1`,
      [idea.id, `Anforderung konnte nicht erstellt werden: ${output.slice(-600) || 'leere Antwort'}`],
    );
    return 0;
  }
  if (estimate) {
    // Values entered by the user stay untouched.
    await pool.query(
      `UPDATE ideation_items SET effort_hours = COALESCE(effort_hours, $2), token_estimate = COALESCE(token_estimate, $3),
              benefit = COALESCE(benefit, $4), cost = COALESCE(cost, $5) WHERE id = $1`,
      [idea.id, estimate.effortHours, estimate.tokenEstimate, estimate.benefit, estimate.cost],
    );
  }
  const risks = await assessRisks(pool, options, idea.title, output, execute);
  const projectContext = await loadProjectContext(pool, options.project);
  if (isShuttingDown()) {
    await pool.query(`UPDATE ideation_items SET status = 'requested', updated_at = NOW() WHERE id = $1`, [idea.id]);
    return 0;
  }
  if (existing) {
    if (!['backlog', 'planned', 'blocked'].includes(existing.status)) {
      await pool.query(
        `UPDATE ideation_items SET status = 'accepted',
                agent_note = 'Der Auftrag ist bereits in Arbeit oder erledigt und wurde nicht überschrieben.', updated_at = NOW() WHERE id = $1`,
        [idea.id],
      );
      return 0;
    }
    await pool.query(
      `UPDATE development_items d SET description = $2, risks = $3, project_context = $4,
              effort_hours = COALESCE(d.effort_hours, i.effort_hours), token_estimate = COALESCE(d.token_estimate, i.token_estimate),
              benefit = COALESCE(d.benefit, i.benefit), cost = COALESCE(d.cost, i.cost), updated_at = NOW()
         FROM ideation_items i WHERE d.id = $1 AND i.id = d.ideation_id`,
      [existing.id, output.slice(0, 10_000), risks, projectContext],
    );
  } else
    await pool.query(
      `INSERT INTO development_items (project_slug, ideation_id, title, description, status, priority,
                                    effort_hours, token_estimate, benefit, cost, risks, project_context)
     SELECT i.project_slug, i.id, i.title, $2, 'backlog', i.priority, i.effort_hours, i.token_estimate, i.benefit, i.cost, $3, $4
       FROM ideation_items i
      WHERE i.id = $1 AND NOT EXISTS (SELECT 1 FROM development_items d WHERE d.ideation_id = i.id)`,
      [idea.id, output.slice(0, 10_000), risks, projectContext],
    );
  await pool.query(
    `UPDATE ideation_items SET status = 'accepted',
            agent_note = 'Anforderung vom Agenten erstellt – Auftrag liegt im Backlog.',
            updated_at = NOW() WHERE id = $1`,
    [idea.id],
  );
  return 1;
}
