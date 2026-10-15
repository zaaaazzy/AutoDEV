import type { Pool } from 'pg';
import { loadProjectContext, withProjectContext } from './project-context.js';
import { isShuttingDown } from './shutdown.js';
import { type CommandExecutor, redactOutput, runCommand } from './command.js';
import { runOllamaAgent } from './ollama-agent.js';
import { agentEnvironment, buildInvocation, defaultAgentCommand, type RunnerOptions } from './runner.js';

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
  '## Ziel', '## Anforderungen (Liste)', '## Akzeptanzkriterien (Liste, prüfbar)',
  '## Technische Hinweise (betroffene Dateien/Module nach Prüfung des Projekts)', '## Risiken & Abgrenzung',
  'Erfinde keine Dateien. Beschreibe nur, was umgesetzt werden soll – ändere selbst nichts.',
].join('\n');

export function buildRequirementPrompt(instructions: string, idea: Idea, current?: string): string {
  return [
    'Du bist der Agent "Auftragsautor" und machst aus einer Idee eine umsetzbare Anforderung für einen Entwicklungsauftrag.',
    `## Anweisung\n${instructions || 'Formuliere präzise, umsetzbare Anforderungen.'}`,
    `## Idee\nTitel: ${idea.title}\nPriorität: ${idea.priority}\n${idea.description}`,
    ...(idea.comments.length ? [`## Kommentare zur Idee (berücksichtigen)\n${idea.comments.map((comment) => `- ${comment}`).join('\n')}`] : []),
    ...(current ? [`## Bisherige Anforderung\n${current}\nÜberarbeite sie unter Berücksichtigung der Kommentare und gib die vollständige neue Fassung aus.`] : []),
    FORMAT,
  ].join('\n\n');
}

/** Runs the project's author agent (own command, default command or local model) and returns its redacted output. */
export async function runAuthorAgent(
  pool: Pool,
  options: Pick<RunnerOptions, 'project' | 'cwd' | 'timeoutMs'>,
  buildPrompt: (instructions: string) => string,
  execute: CommandExecutor = runCommand,
): Promise<{ exitCode: number; output: string }> {
  const author = (await pool.query<{ instructions: string; command: string[] | null }>(
    `SELECT instructions, command FROM agents
      WHERE project_slug = $1 AND role = 'author' AND enabled ORDER BY position LIMIT 1`,
    [options.project],
  )).rows[0];
  const prompt = withProjectContext(await loadProjectContext(pool, options.project), buildPrompt(author?.instructions ?? ''));
  const command = author?.command?.length ? author.command : defaultAgentCommand();
  try {
    const result = command
      ? await execute(buildInvocation(command, prompt), options.cwd, { timeoutMs: options.timeoutMs, env: agentEnvironment() })
      : await runOllamaAgent({ prompt, role: 'author', cwd: options.cwd, timeoutMs: options.timeoutMs });
    return { exitCode: result.exitCode, output: redactOutput(result.output, process.env).trim() };
  } catch (error) {
    return { exitCode: 1, output: error instanceof Error ? error.message : String(error) };
  }
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
  const idea: Idea = { ...claimedIdea, comments: (await pool.query<{ line: string }>(
    `SELECT author || ': ' || body AS line FROM ideation_comments WHERE ideation_id = $1 ORDER BY created_at`, [claimedIdea.id],
  )).rows.map((row) => row.line) };
  const existing = (await pool.query<{ id: string; description: string; status: string }>(
    `SELECT id, description, status FROM development_items WHERE ideation_id = $1 LIMIT 1`, [idea.id],
  )).rows[0];
  console.info(`[idea ${idea.id}] Anforderung erstellen`);
  const { exitCode, output } = await runAuthorAgent(
    pool, options, (instructions) => buildRequirementPrompt(instructions, idea, existing?.description), execute,
  );
  if (isShuttingDown()) {
    await pool.query(`UPDATE ideation_items SET status = 'requested', updated_at = NOW() WHERE id = $1`, [idea.id]);
    return 0;
  }
  if (exitCode !== 0 || output.length < MIN_REQUIREMENT_CHARS) {
    await pool.query(
      `UPDATE ideation_items SET status = 'considering', agent_note = $2, updated_at = NOW() WHERE id = $1`,
      [idea.id, `Anforderung konnte nicht erstellt werden: ${output.slice(-600) || 'leere Antwort'}`],
    );
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
    await pool.query(`UPDATE development_items SET description = $2, updated_at = NOW() WHERE id = $1`, [existing.id, output.slice(0, 10_000)]);
  } else await pool.query(
    `INSERT INTO development_items (project_slug, ideation_id, title, description, status, priority,
                                    effort_hours, token_estimate, benefit, cost)
     SELECT i.project_slug, i.id, i.title, $2, 'backlog', i.priority, i.effort_hours, i.token_estimate, i.benefit, i.cost
       FROM ideation_items i
      WHERE i.id = $1 AND NOT EXISTS (SELECT 1 FROM development_items d WHERE d.ideation_id = i.id)`,
    [idea.id, output.slice(0, 10_000)],
  );
  await pool.query(
    `UPDATE ideation_items SET status = 'accepted',
            agent_note = 'Anforderung vom Agenten erstellt – Auftrag liegt im Backlog.',
            updated_at = NOW() WHERE id = $1`,
    [idea.id],
  );
  return 1;
}
