import { randomUUID } from 'node:crypto';
import { logged } from '../core/log.js';
import {
  readOnlyWorkspace,
  SANDBOX_GUARD,
  SANDBOX_WORKDIR,
  sandboxExecutor,
  sandboxMode,
  usesSandbox,
} from '../core/sandbox.js';
import { projectSandbox } from '../runner/test-sandbox.js';
import { dashboardCommand } from './system-agents.js';
import type { Pool } from 'pg';
import { loadProjectContext, loadProjectRules, withProjectContext } from '../core/project-context.js';
import { isShuttingDown } from '../core/shutdown.js';
import { type CommandExecutor, redactOutput, runCommand } from '../core/command.js';
import { loadKnownBugs } from '../db/bugs-repository.js';
import { isUniqueViolation } from '../db/transaction.js';
import { knownBugLine } from '../core/known-bugs.js';
import { type ActualReference, loadActualReference, referenceSection, splitEstimate } from './estimation.js';
import { budgetTodo, checkBudget } from '../runner/budget.js';
import { runOllamaAgent } from './ollama-agent.js';
import {
  agentRights,
  loadProjectPermissions,
  FULL_ACCESS_ROLES,
  READ_ONLY_PERMISSION_ROLE,
  READ_ONLY_ROLES,
  withAgentPermissions,
} from './tool-permissions.js';
import { executeAgentCommand, isClaudeCommand } from './claude-stream.js';
import { DEFAULT_DEFINITION_OF_READY, loadDefinitions } from '../runner/acceptance.js';
import { shortTitle, TITLE_MAX } from '../core/validation.js';
import { containsUntrusted, UNTRUSTED_HINT } from '../core/bug-trust.js';
import { agentEnvironment, buildInvocation } from '../runner/runner-prompts.js';
import { defaultAgentCommand } from '../runner/runner-selection.js';
import type { RunnerOptions } from '../runner/runner-types.js';
import { defined } from '../core/defined.js';

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
  /** Herkunft; `github` heißt: Titel und Text stammen aus einem fremden Issue. */
  source?: string;
}

const TITLE_LINE = /^\s*@@TITEL:\s*(.+)$/m;

/** Trennt die Zeile „@@TITEL: …“ (kurzer Auftragstitel des Auftragsautors) vom Anforderungstext. */
interface AgentRights {
  instructions: string;
  command: string[] | null;
  allowedCommands: string[] | null;
  fileScope: string[];
  role?: string | null;
}

/**
 * Rolle, deren Rechte ein Lauf bekommt. Ein gewählter Agent bringt Befehl und Freigaben mit; läuft er unter einer
 * Vollzugriffs-Rolle (Chat-Assistent), gelten seine eigenen Rollenrechte – sonst hätte etwa ein Entwickler mit
 * `--dangerously-skip-permissions` im Chat keinen Wächter. Lesende oder fehlende Rollen: nur lesen (fail-closed).
 */
function permissionRole(role: string, agentId: string | null | undefined, author: AgentRights | undefined): string {
  if (!agentId || !FULL_ACCESS_ROLES.has(role) || author?.role === role) return role;
  if (!author?.role || READ_ONLY_ROLES.has(author.role)) return READ_ONLY_PERMISSION_ROLE;
  return author.role;
}

export function splitTitle(output: string): { title: string | null; text: string } {
  const match = TITLE_LINE.exec(output);
  if (!match) return { title: null, text: output };
  const title = shortTitle(defined(match[1]).replace(/^["„“]+|["„“]+$/g, ''), TITLE_MAX);
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
  '{"effortHours": Agent-Stunden, "tokenEstimate": Tokens, "benefit": 0-10, "cost": 0-10}',
  'effortHours: erwartete Agent-Laufzeit in Stunden (Summe aller Agent-Schritte, z. B. 0.3), nicht die Arbeitszeit ' +
    'eines Menschen. tokenEstimate: erwarteter Tokenverbrauch aller Agent-Läufe des Auftrags (Entwickler, Tester, ' +
    'Dokumentation), grob aus Anzahl und Größe der betroffenen Dateien berechnet; cost: Aufwand relativ 0 (gering) ' +
    'bis 10 (hoch).',
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
    // Issue-Import: Titel und Text sind fremde Daten (Prompt-Injection), nie Anweisungen.
    ...(idea.source === 'github' || containsUntrusted(idea.description) ? [UNTRUSTED_HINT] : []),
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
 * Runs the project's agent of the given role (default: author) (own command, the agent chosen on the dashboard,
 * default command or local model) and returns its redacted output.
 */
export async function runAuthorAgent(
  pool: Pool,
  options: Pick<RunnerOptions, 'project' | 'cwd' | 'timeoutMs'>,
  buildPrompt: (instructions: string) => string,
  execute: CommandExecutor = runCommand,
  role = 'author',
  onProgress?: (message: string) => void,
  /** Setzt eine frühere Claude-Sitzung mit einer kurzen Nachricht fort (nur Claude-CLI, sonst voller Prompt). */
  resume?: { sessionId: string; prompt: string },
  /**
   * Vom Nutzer gewählter Agent des Projekts (Name, Beschreibung, Modell). Unter einer Vollzugriffs-Rolle gelten die
   * Rechte seiner eigenen Rolle (siehe permissionRole), sonst die der Rolle `role`.
   */
  agentId?: string | null,
  /** Bricht den Lauf ab (z. B. „Abbrechen“ beim Visionär): beendet die CLI bzw. das lokale Modell. */
  signal?: AbortSignal,
  /**
   * Nur lesen, unabhängig von der Rolle. Standard: ja. Diese Läufe (Auftragsautor, Bug-Wächter, Visionär, Analyse,
   * Abnahme, Sprint-Kommentar) arbeiten parallel zu Aufträgen im selben Ordner; schreiben darf nur, wer den
   * Arbeitsordner hält (`acquireTree`/`tryAcquireTree`) und deshalb ausdrücklich `false` übergibt – wie der Chat.
   */
  readOnly = true,
): Promise<{
  exitCode: number;
  output: string;
  sessionId?: string;
  tokens?: number;
  /** Rechte für @@SERVICES-Marker der Claude-CLI (nur schreibende Läufe); das lokale Modell hat service_action. */
  serviceRights?: { role: string; commands: string[] };
}> {
  const author = (
    agentId
      ? await pool.query<AgentRights>(
          `SELECT instructions, command, allowed_commands AS "allowedCommands", file_scope AS "fileScope", role
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
  // Agent-Rollen (Autor, Bug-Wächter) zählen über agent_usage.role zusätzlich gegen ihr Rollen-Limit.
  const budget = await checkBudget(pool, options.project, { role }).catch(logged('requirements', null));
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
  // Rechte einer lesenden Rolle: keine Datei-Werkzeuge, keine Shell, auch kein voller Zugriff.
  const rightsRole = readOnly ? READ_ONLY_PERMISSION_ROLE : permissionRole(role, agentId, author);
  // Sandbox (Standard workbench): schreibende Läufe gehen in den Arbeitscontainer des Projekts, lesende in einen
  // kurzlebigen Container, der den Ordner nur als :ro sieht.
  // Beim lokalen Modell laufen nur dessen Shell-Befehle im Container, die Datei-Werkzeuge im Worker (wie im Runner).
  const mode = sandboxMode(await projectSandbox(pool, options.project));
  const inSandbox = usesSandbox(mode);
  const sandboxed = Boolean(configured) && inSandbox;
  const agentExecute = inSandbox
    ? sandboxExecutor(options.cwd, {
        runId: `${role}-${randomUUID().slice(0, 8)}`,
        project: options.project,
        readOnly: readOnly || readOnlyWorkspace(role),
        docker: execute,
        mode,
      })
    : execute;
  const agentCwd = sandboxed ? SANDBOX_WORKDIR : options.cwd;
  const command =
    configured &&
    withAgentPermissions(
      configured,
      rightsRole,
      permissions,
      author?.allowedCommands ?? null,
      author?.fileScope ?? [],
      sandboxed ? [] : undefined,
      agentCwd,
      sandboxed ? SANDBOX_GUARD : undefined,
    );
  // Auch fortgesetzte Sitzungen bekommen die Projektregeln erneut mit, damit sie für jede Nachricht gelten. Im
  // Container gibt es die frühere Sitzung nicht (kein ~/.claude): dort startet der Lauf mit dem vollen Prompt.
  const rules = resume && !sandboxed ? await loadProjectRules(pool, options.project) : '';
  const resuming =
    resume && !sandboxed && command && isClaudeCommand(command)
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
  const rights = agentRights(rightsRole, permissions, author?.allowedCommands ?? null, author?.fileScope ?? []);
  try {
    const result = command
      ? await executeAgentCommand(agentExecute, buildInvocation(command, resuming?.prompt ?? prompt), agentCwd, {
          timeoutMs: options.timeoutMs,
          env: agentEnvironment(options.cwd),
          onAction: onProgress,
          resumeSession: resuming?.sessionId,
          onSpawn: (spawned) => {
            pid = spawned;
            if (signal?.aborted) kill();
          },
          // Im Container beendet erst docker kill den Lauf (der Client allein liesse ihn weiterlaufen).
          ...(sandboxed ? { signal } : {}),
        })
      : await runOllamaAgent({
          prompt,
          role,
          cwd: options.cwd,
          timeoutMs: options.timeoutMs,
          onProgress,
          signal,
          readOnly,
          // Dieselben Datei- und Befehlsrechte wie bei der Claude-CLI (sonst liefe der Chat ohne Wächter).
          ...rights,
          ...(inSandbox ? { execute: agentExecute } : {}),
        });
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
    if (budget?.states.length) await checkBudget(pool, options.project, { role }).catch(logged('requirements', null));
    return {
      exitCode: result.exitCode,
      output: redactOutput(result.output, process.env).trim(),
      sessionId: 'sessionId' in result ? (result.sessionId as string | undefined) : undefined,
      tokens: result.tokens ?? 0,
      ...(command && !readOnly ? { serviceRights: { role: rightsRole, commands: rights.commands } } : {}),
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
  const list = bugs.map(knownBugLine);
  const { exitCode, output } = await runAuthorAgent(
    pool,
    options,
    (instructions) =>
      [
        'Du bist der Agent "Bug-Wächter". Prüfe, welche der bisherigen Bugs zum Kontext des Auftrags passen.',
        `## Anweisung\n${instructions}`,
        `## Auftrag\nTitel: ${title}\n${description}`,
        `## Alle bisherigen Bugs\n${list.join('\n')}`,
        list.some(containsUntrusted) ? UNTRUSTED_HINT : '',
        'Antworte als Markdown-Liste nur mit den passenden Bugs: Bug, warum relevant, was nicht wiederholt werden darf. Passt keiner, schreibe "Keine relevanten Bugs." Ändere nichts.',
      ]
        .filter(Boolean)
        .join('\n\n'),
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

/**
 * Schätzung des Auftragsautors speichern: Von Hand eingetragene Werte bleiben; Schnellschätzung und Altbestand ersetzt
 * er, denn er kennt die Anforderung und die Ist-Werte ähnlicher Aufträge. Nutzen und Kosten bleiben, wenn gesetzt.
 */
export const AUTHOR_ESTIMATE_SQL = `
  UPDATE ideation_items SET
        effort_hours = CASE WHEN estimate_source = 'manual' AND effort_hours IS NOT NULL THEN effort_hours
                            ELSE COALESCE($2, effort_hours) END,
        token_estimate = CASE WHEN estimate_source = 'manual' AND token_estimate IS NOT NULL THEN token_estimate
                              ELSE COALESCE($3, token_estimate) END,
        benefit = COALESCE(benefit, $4), cost = COALESCE(cost, $5),
        estimate_source = CASE WHEN estimate_source = 'manual' THEN 'manual'
                               WHEN $2::float8 IS NOT NULL OR $3::bigint IS NOT NULL THEN 'author'
                               ELSE estimate_source END
  WHERE id = $1
`;

/** Überarbeitete Anforderung in den bestehenden Auftrag übernehmen; eine Schätzung von Hand am Auftrag bleibt. */
export const REDRAFT_ORDER_SQL = `
  UPDATE development_items d SET description = $2, risks = $3, project_context = $4,
       effort_hours = CASE WHEN d.estimate_source = 'manual' AND d.effort_hours IS NOT NULL THEN d.effort_hours
                           ELSE COALESCE(i.effort_hours, d.effort_hours) END,
       token_estimate = CASE WHEN d.estimate_source = 'manual' AND d.token_estimate IS NOT NULL THEN d.token_estimate
                             ELSE COALESCE(i.token_estimate, d.token_estimate) END,
       estimate_source = CASE WHEN d.estimate_source = 'manual' THEN 'manual'
                              ELSE COALESCE(i.estimate_source, d.estimate_source) END,
       benefit = COALESCE(d.benefit, i.benefit), cost = COALESCE(d.cost, i.cost), updated_at = NOW()
  FROM ideation_items i WHERE d.id = $1 AND i.id = d.ideation_id
`;

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
      RETURNING id, project_slug AS "projectSlug", title, description, priority, source, category`,
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
    await pool.query(AUTHOR_ESTIMATE_SQL, [
      idea.id,
      estimate.effortHours,
      estimate.tokenEstimate,
      estimate.benefit,
      estimate.cost,
    ]);
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
    await pool.query(REDRAFT_ORDER_SQL, [existing.id, output.slice(0, 10_000), risks, projectContext]);
  } else
    await pool
      .query(
        `INSERT INTO development_items (project_slug, ideation_id, title, description, status, priority,
                                    effort_hours, token_estimate, benefit, cost, risks, project_context, estimate_source)
     SELECT i.project_slug, i.id, COALESCE($5, i.title), $2, 'backlog', i.priority, i.effort_hours, i.token_estimate, i.benefit, i.cost, $3, $4,
            i.estimate_source
       FROM ideation_items i
      WHERE i.id = $1 AND NOT EXISTS (SELECT 1 FROM development_items d WHERE d.ideation_id = i.id)`,
        // Neuer Auftrag: kurzer Titel des Auftragsautors; ein bestehender behält seinen (evtl. von Hand gesetzten) Titel.
        [idea.id, output.slice(0, 10_000), risks, projectContext, shortened ?? shortTitle(idea.title, TITLE_MAX)],
      )
      .catch((error: unknown) => {
        // Inzwischen von Hand übernommen (Unique-Index auf ideation_id): Der Auftrag existiert, die Idee ist angenommen.
        if (!isUniqueViolation(error)) throw error;
      });
  await pool.query(
    `UPDATE ideation_items SET status = 'accepted', progress = NULL, progress_agent = NULL,
            agent_note = 'Anforderung vom Agenten erstellt – Auftrag liegt im Backlog.',
            updated_at = NOW() WHERE id = $1`,
    [idea.id],
  );
  return 1;
}
