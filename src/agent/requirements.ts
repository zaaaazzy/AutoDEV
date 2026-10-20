import { logged } from '../core/log.js';
import { restrictedSystemCommand, systemCommand } from './system-agents.js';
import type { Pool } from 'pg';
import { loadProjectContext, loadProjectRules, withProjectContext } from '../core/project-context.js';
import { isShuttingDown } from '../core/shutdown.js';
import { type CommandExecutor, redactOutput, runCommand } from '../core/command.js';
import { loadKnownBugs } from '../api/bugs.js';
import { type ActualReference, loadActualReference, referenceSection, splitEstimate } from './estimation.js';
import { budgetTodo, checkBudget } from '../runner/budget.js';
import { runOllamaAgent } from './ollama-agent.js';
import { loadProjectPermissions, withAgentPermissions } from './tool-permissions.js';
import { executeAgentCommand, isClaudeCommand } from './claude-stream.js';
import { DEFAULT_DEFINITION_OF_READY, loadDefinitions } from '../runner/acceptance.js';
import { shortTitle, TITLE_MAX } from '../core/validation.js';
import { agentEnvironment, buildInvocation, defaultAgentCommand, type RunnerOptions } from '../runner/runner.js';

const MIN_REQUIREMENT_CHARS = 80;
const PROMPT_LOG_CHARS = 30_000;
const STALE_DRAFT_MINUTES = 45;

interface Idea {
  id: string;
  projectSlug: string;
  title: string;
  description: string;
  priority: string;
  category?: string | null;
  comments: string[];
}

const TITLE_LINE = /^\s*@@TITEL:\s*(.+)$/m;

/** Trennt die Zeile „@@TITEL: …“ (kurzer Auftragstitel des Auftragsautors) vom Anforderungstext. */
interface AgentRights {
  instructions: string;
  command: string[] | null;
  allowedCommands: string[] | null;
  fileScope: string[];
}

export function splitTitle(output: string): { title: string | null; text: string } {
  const match = TITLE_LINE.exec(output);
  if (!match) return { title: null, text: output };
  const title = shortTitle(match[1]!.replace(/^["„“]+|["„“]+$/g, ''), TITLE_MAX);
  return {
    title: title || null,
    text: (output.slice(0, match.index) + output.slice(match.index + match[0].length)).trim(),
  };
}

const FORMAT = [
  `Beginne mit genau einer Zeile \`@@TITEL: <Auftragstitel>\`: höchstens 60 Zeichen, sagt knapp, was entsteht ` +
    '(z. B. „Dunkelmodus für Einstellungen“), ohne Projektname, ohne Begründung, ohne Satzzeichen am Ende.',
  'Schreibe danach die Anforderung als Markdown mit genau diesen Abschnitten:',
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

export function buildRequirementPrompt(
  instructions: string,
  idea: Idea,
  current?: string,
  definitionOfReady: string[] = DEFAULT_DEFINITION_OF_READY,
  /** Ist-Werte erledigter Aufträge derselben Kategorie (lernende Schätzung). */
  reference: ActualReference | null = null,
): string {
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
    ...(reference ? [referenceSection(reference)] : []),
    `## Definition of Ready (vor der Abgabe prüfen)\n${definitionOfReady.map((item) => `- ${item}`).join('\n')}\n` +
      'Schreibe die Akzeptanzkriterien als Liste mit genau einem prüfbaren Satz je Punkt – der Tester hakt sie einzeln ab.',
  ].join('\n\n');
}

/**
 * CLI chosen in the dashboard for the chat assistant or the analysis. "author" is left out on purpose: its
 * dashboard choice belongs to the quick estimation only, not to writing requirements. The analysis stays read-only
 * unless full tool access was allowed for it in the dashboard.
 */
async function dashboardCommand(pool: Pool, role: string): Promise<string[] | null> {
  if (role !== 'assistant' && role !== 'analyst') return null;
  return role === 'analyst' ? restrictedSystemCommand(pool, role) : systemCommand(pool, role);
}

/** Runs the project's agent of the given role (default: author) (own command, default command or local model) and returns its redacted output. */
export async function runAuthorAgent(
  pool: Pool,
  options: Pick<RunnerOptions, 'project' | 'cwd' | 'timeoutMs'>,
  buildPrompt: (instructions: string) => string,
  execute: CommandExecutor = runCommand,
  role = 'author',
  onProgress?: (message: string) => void,
  /** Setzt eine frühere Claude-Sitzung mit einer kurzen Nachricht fort (nur Claude-CLI, sonst voller Prompt). */
  resume?: { sessionId: string; prompt: string },
  /** Vom Nutzer gewählter Agent des Projekts (Name, Beschreibung, Modell); Rechte bleiben die der Rolle `role`. */
  agentId?: string | null,
  /** Bricht den Lauf ab (z. B. „Abbrechen“ beim Visionär): beendet die CLI bzw. das lokale Modell. */
  signal?: AbortSignal,
): Promise<{ exitCode: number; output: string; sessionId?: string }> {
  const author = (
    agentId
      ? await pool.query<AgentRights>(
          `SELECT instructions, command, allowed_commands AS "allowedCommands", file_scope AS "fileScope"
             FROM agents WHERE project_slug = $1 AND id = $2`,
          [options.project, agentId],
        )
      : await pool.query<AgentRights>(
          `SELECT instructions, command, allowed_commands AS "allowedCommands", file_scope AS "fileScope" FROM agents
          WHERE project_slug = $1 AND role = $2 AND enabled ORDER BY position LIMIT 1`,
          [options.project, role],
        )
  ).rows[0];
  const prompt = withProjectContext(
    await loadProjectContext(pool, options.project),
    buildPrompt(author?.instructions ?? ''),
  );
  // Budget-Prüfpunkt auch für Chat, Auftragsautor, Visionär & Co.: ist Tag oder Sprint erreicht, startet kein Lauf.
  const budget = await checkBudget(pool, options.project).catch(logged('requirements', null));
  if (budget?.exceeded) {
    return {
      exitCode: 1,
      output: `${budgetTodo(budget.exceeded)}. Das Limit lässt sich unter Einstellungen → Budget ändern.`,
    };
  }
  const configured = author?.command?.length
    ? author.command
    : ((await dashboardCommand(pool, role)) ?? defaultAgentCommand());
  // Rechte: die des gewählten bzw. zuständigen Agents (eigene Zuweisung), sonst der Projektstandard der Rolle.
  const permissions = await loadProjectPermissions(pool, options.project);
  const command =
    configured &&
    withAgentPermissions(configured, role, permissions, author?.allowedCommands ?? null, author?.fileScope ?? []);
  // Auch fortgesetzte Sitzungen bekommen die Projektregeln erneut mit, damit sie für jede Nachricht gelten.
  const rules = resume ? await loadProjectRules(pool, options.project) : '';
  const resuming =
    resume && command && isClaudeCommand(command)
      ? { ...resume, prompt: rules ? `${rules}\n\n${resume.prompt}` : resume.prompt }
      : undefined;
  let pid: number | undefined;
  // Der Agent läuft als eigene Prozessgruppe (detached); so endet auch alles, was er gestartet hat.
  const kill = (): void => {
    if (pid) {
      try {
        process.kill(-pid, 'SIGTERM');
      } catch {
        // bereits beendet
      }
    }
  };
  signal?.addEventListener('abort', kill, { once: true });
  try {
    const result = command
      ? await executeAgentCommand(execute, buildInvocation(command, resuming?.prompt ?? prompt), options.cwd, {
          timeoutMs: options.timeoutMs,
          env: agentEnvironment(options.cwd),
          onAction: onProgress,
          resumeSession: resuming?.sessionId,
          onSpawn: (spawned) => {
            pid = spawned;
            if (signal?.aborted) kill();
          },
        })
      : await runOllamaAgent({ prompt, role, cwd: options.cwd, timeoutMs: options.timeoutMs, onProgress, signal });
    await pool
      .query(
        `INSERT INTO agent_usage (project_slug, role, tokens, duration_ms, cost_usd, success, prompt)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          options.project,
          role,
          result.tokens ?? 0,
          Math.round(result.durationMs ?? 0),
          'costUsd' in result ? (result.costUsd ?? 0) : 0,
          result.exitCode === 0,
          // Prompt-Protokoll (z. B. mit den Ist-Werten ähnlicher Aufträge im Autor-Prompt), maskiert und gekürzt.
          redactOutput(resuming?.prompt ?? prompt, process.env).slice(0, PROMPT_LOG_CHARS),
        ],
      )
      .catch(logged('requirements'));
    // Nach dem Buchen: 80-%-Warnung, falls dieser Lauf die Schwelle überschritten hat.
    if (budget?.states.length) await checkBudget(pool, options.project).catch(logged('requirements', null));
    return {
      exitCode: result.exitCode,
      output: redactOutput(result.output, process.env).trim(),
      sessionId: 'sessionId' in result ? (result.sessionId as string | undefined) : undefined,
    };
  } catch (error) {
    return { exitCode: 1, output: error instanceof Error ? error.message : String(error) };
  } finally {
    signal?.removeEventListener('abort', kill);
  }
}

/** Der Bug-Wächter prüft alle bisherigen Bugs auf Bezug zum Auftrag; ohne Antwort bleibt eine mechanische Liste. */
async function assessRisks(
  pool: Pool,
  options: Pick<RunnerOptions, 'project' | 'cwd' | 'timeoutMs'>,
  title: string,
  description: string,
  execute: CommandExecutor,
  onProgress?: (message: string) => void,
): Promise<string> {
  const bugs = await loadKnownBugs(pool, options.project, 60).catch(logged('requirements', []));
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
    onProgress,
  );
  return exitCode === 0 && output
    ? output.slice(0, 6000)
    : `Bekannte Bugs (nicht gefiltert):\n${list.slice(0, 15).join('\n')}`;
}

/** Hält fest, was beim Schreiben eines Auftrags gerade passiert (Anzeige unter „Auftrag → In Entstehung“). */
async function draftProgress(pool: Pool, ideaId: string, agent: string, message: string): Promise<void> {
  await pool
    .query(`UPDATE ideation_items SET progress = $3, progress_agent = $2 WHERE id = $1 AND status = 'drafting'`, [
      ideaId,
      agent,
      message.slice(0, 300),
    ])
    .catch(logged('requirements'));
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
    `UPDATE ideation_items SET status = 'drafting', agent_note = NULL, updated_at = NOW(), drafting_started_at = NOW(),
             progress = 'Liest die Idee und den Projektkontext …', progress_agent = 'author'
      WHERE id = (SELECT id FROM ideation_items WHERE project_slug = $1 AND status = 'requested'
                   ORDER BY updated_at LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING id, project_slug AS "projectSlug", title, description, priority, category`,
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
  const definitions = await loadDefinitions(pool, options.project);
  const reference = await loadActualReference(pool, options.project, idea.category ?? null).catch(
    logged('requirements', null),
  );
  console.info(`[idea ${idea.id}] Anforderung erstellen`);
  const { exitCode, output: rawOutput } = await runAuthorAgent(
    pool,
    options,
    (instructions) => buildRequirementPrompt(instructions, idea, existing?.description, definitions.ready, reference),
    execute,
    'author',
    (message) => void draftProgress(pool, idea.id, 'author', message),
  );
  if (isShuttingDown()) {
    await pool.query(
      `UPDATE ideation_items SET status = 'requested', progress = NULL, progress_agent = NULL, updated_at = NOW() WHERE id = $1`,
      [idea.id],
    );
    return 0;
  }
  const { title: shortened, text } = splitTitle(rawOutput);
  const { requirement: output, estimate } = splitEstimate(text);
  if (exitCode !== 0 || output.length < MIN_REQUIREMENT_CHARS) {
    await pool.query(
      `UPDATE ideation_items SET status = 'considering', agent_note = $2, progress = NULL, progress_agent = NULL, updated_at = NOW() WHERE id = $1`,
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
  await draftProgress(pool, idea.id, 'bug_reviewer', 'Prüft bekannte Bugs auf Bezug zum Auftrag …');
  const risks = await assessRisks(
    pool,
    options,
    idea.title,
    output,
    execute,
    (message) => void draftProgress(pool, idea.id, 'bug_reviewer', message),
  );
  const projectContext = await loadProjectContext(pool, options.project);
  if (isShuttingDown()) {
    await pool.query(
      `UPDATE ideation_items SET status = 'requested', progress = NULL, progress_agent = NULL, updated_at = NOW() WHERE id = $1`,
      [idea.id],
    );
    return 0;
  }
  if (existing) {
    if (!['backlog', 'planned', 'blocked'].includes(existing.status)) {
      await pool.query(
        `UPDATE ideation_items SET status = 'accepted', progress = NULL, progress_agent = NULL,
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
     SELECT i.project_slug, i.id, COALESCE($5, i.title), $2, 'backlog', i.priority, i.effort_hours, i.token_estimate, i.benefit, i.cost, $3, $4
       FROM ideation_items i
      WHERE i.id = $1 AND NOT EXISTS (SELECT 1 FROM development_items d WHERE d.ideation_id = i.id)`,
      // Neuer Auftrag: kurzer Titel des Auftragsautors; ein bestehender behält seinen (evtl. von Hand gesetzten) Titel.
      [idea.id, output.slice(0, 10_000), risks, projectContext, shortened ?? shortTitle(idea.title, TITLE_MAX)],
    );
  await pool.query(
    `UPDATE ideation_items SET status = 'accepted', progress = NULL, progress_agent = NULL,
            agent_note = 'Anforderung vom Agenten erstellt – Auftrag liegt im Backlog.',
            updated_at = NOW() WHERE id = $1`,
    [idea.id],
  );
  return 1;
}
