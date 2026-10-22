import { logged } from '../core/log.js';
import { parseActionLine, setActionTodo } from '../runner/action-todo.js';
import { delegateAfterAnalysis } from '../runner/autofix.js';
import type { Pool } from 'pg';
import { loadKnownBugs } from '../api/bugs.js';
import type { CommandExecutor } from '../core/command.js';
import { runAuthorAgent } from './requirements.js';
import type { RunnerOptions } from '../runner/runner.js';
import { isShuttingDown } from '../core/shutdown.js';

const MIN_ANALYSIS_CHARS = 60;

export function buildTroubleshootPrompt(
  instructions: string,
  item: { title: string; description: string },
  failures: string[],
  bugs: string[],
): string {
  return [
    'Du bist der Problemanalyst im AIdeation (nur lesender Zugriff). Ein Entwicklungsauftrag ist blockiert. Analysiere die Fehler, finde die Ursache und schlage eine konkrete Lösung vor. Diese angeforderte Analyse dokumentiert den Befund, ohne den Auftrag ungefragt umzusetzen.',
    `## Anweisung\n${instructions || 'Analysiere gründlich und nenne konkrete Schritte.'}`,
    `## Auftrag\nTitel: ${item.title}\n${item.description.slice(0, 3000)}`,
    `## Fehlgeschlagene Schritte (neueste zuerst)\n${failures.join('\n\n') || 'Keine Fehlerausgabe vorhanden.'}`,
    bugs.length ? `## Bereits bekannte Bugs\n${bugs.join('\n')}` : '',
    [
      'Antworte genau in diesem Format:',
      'TITEL: <kurzer, allgemeiner Fehlertitel, an dem man das Problem später wiedererkennt>',
      'AKTION: <in wenigen Worten, was ein Mensch tun muss (z. B. „API-Schlüssel in .env eintragen“) – oder „keine“, wenn die Agents es selbst beheben können>',
      '## Ursache',
      '## Lösung (konkrete Schritte)',
      '## Erkennung (woran man das Problem früh erkennt, Stichworte)',
    ].join('\n'),
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** Zerlegt die Antwort des Problemlösers in Bug-Titel und Text. */
export function parseAnalysis(output: string, fallbackTitle: string): { title: string; body: string } {
  const match = output.match(/^\s*TITEL:\s*(.+)$/im);
  const title = (match?.[1] ?? '').trim().replace(/^["„]|["“]$/g, '') || fallbackTitle;
  return {
    title: title.slice(0, 160),
    body: output
      .replace(/^\s*TITEL:.*$/im, '')
      .replace(/^\s*AKTION:.*$/im, '')
      .trim(),
  };
}

/** Analysiert einen blockierten Auftrag mit dem Dashboard-Assistenten und speichert die Erkenntnisse als Bug (für den Bug-Wächter). */
export async function analyzeBlocked(
  pool: Pool,
  options: Pick<RunnerOptions, 'project' | 'cwd' | 'timeoutMs'>,
  execute?: CommandExecutor,
): Promise<number> {
  const claimed = await pool.query<{
    id: string;
    title: string;
    description: string;
    bugId: string | null;
    kind: string;
    sprintId: string | null;
    failureBugId: string | null;
  }>(
    `UPDATE development_items SET analysis_status = 'running'
      WHERE id = (SELECT id FROM development_items WHERE project_slug = $1 AND analysis_status = 'requested'
                   ORDER BY updated_at LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING id, title, description, bug_id AS "bugId", kind, sprint_id AS "sprintId", failure_bug_id AS "failureBugId"`,
    [options.project],
  );
  const item = claimed.rows[0];
  if (!item) return 0;
  const steps = await pool
    .query<{ agent: string; output: string }>(
      `SELECT s.agent_name AS agent, s.output FROM agent_run_steps s JOIN agent_runs r ON r.id = s.run_id
      WHERE r.development_id = $1 AND s.status = 'failed' ORDER BY s.id DESC LIMIT 3`,
      [item.id],
    )
    .catch(() => ({ rows: [] as { agent: string; output: string }[] }));
  const failures = steps.rows.map((step) => `### ${step.agent}\n${step.output.trim().slice(-2500)}`);
  const known = (await loadKnownBugs(pool, options.project, 30).catch(logged('troubleshoot', []))).map(
    (bug) => `- [${bug.status}] ${bug.title}`,
  );
  console.info(`[${item.id}] Problemanalyse`);
  const { exitCode, output } = await runAuthorAgent(
    pool,
    options,
    (instructions) => buildTroubleshootPrompt(instructions, item, failures, known),
    execute,
    'analyst',
  );
  if (isShuttingDown()) {
    await pool.query(`UPDATE development_items SET analysis_status = 'requested' WHERE id = $1`, [item.id]);
    return 0;
  }
  if (exitCode !== 0 || output.length < MIN_ANALYSIS_CHARS) {
    await pool.query(
      `UPDATE development_items SET analysis_status = 'failed', analysis = $2, updated_at = NOW() WHERE id = $1`,
      [item.id, `Analyse fehlgeschlagen: ${output.slice(-600) || 'leere Antwort'}`],
    );
    return 0;
  }
  const { title, body } = parseAnalysis(output, `Blockiert: ${item.title}`);
  const action = parseActionLine(output);
  if (action !== undefined) await setActionTodo(pool, item.id, action).catch(logged('troubleshoot'));
  if (item.failureBugId) {
    // Bug-Bericht gibt es schon (vom gescheiterten Agent): die Analyse dort ergänzen statt einen zweiten anzulegen.
    await pool.query(`UPDATE bugs SET fix_notes = $2, updated_at = NOW() WHERE id = $1`, [
      item.failureBugId,
      body.slice(0, 3000),
    ]);
  } else {
    await pool.query(
      `INSERT INTO bugs (project_slug, title, description, severity, source, status, fix_notes, development_id)
       SELECT $1, $2, $3, 'high', 'agent', 'open', $4, $5
        WHERE NOT EXISTS (SELECT 1 FROM bugs WHERE project_slug = $1 AND title = $2)`,
      [
        options.project,
        title,
        `Aufgetreten bei Auftrag „${item.title}“.\n\n${body}`.slice(0, 10_000),
        body.slice(0, 3000),
        item.id,
      ],
    );
  }
  await pool.query(
    `UPDATE development_items SET analysis_status = 'done', analysis = $2, updated_at = NOW() WHERE id = $1`,
    [item.id, `**Bug:** ${title}\n\n${body}`.slice(0, 10_000)],
  );
  // Zweite Meinung abgeschlossen: an die Behebung delegieren oder auf eine Aktion warten – mit Vermerk.
  await delegateAfterAnalysis(pool, { ...item, projectSlug: options.project }, { title, action }).catch((error) =>
    console.error('Delegation nach Analyse fehlgeschlagen:', error),
  );
  return 1;
}
