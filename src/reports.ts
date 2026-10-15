import type { Express } from 'express';
import type { Pool } from 'pg';
import { upsertDoc } from './docs.js';
import { isUuid, isRecord, parseProjectSlug } from './validation.js';

interface OrderRow {
  id: string;
  title: string;
  kind: string;
  status: string;
  effortHours: number | null;
}

export interface SprintReport {
  sprintId: string;
  summary: string;
  implemented: { id: string; title: string; kind: string; effortHours: number | null }[];
  missing: { id: string; title: string; status: string }[];
  problems: { type: string; title: string; detail: string }[];
}

const STATUS_DE: Record<string, string> = {
  backlog: 'Backlog', planned: 'Geplant', in_progress: 'In Arbeit', blocked: 'Blockiert', done: 'Erledigt',
};

function toMarkdown(name: string, goal: string, report: SprintReport): string {
  const list = (lines: string[], empty: string): string => (lines.length ? lines.join('\n') : empty);
  return [
    `# Sprint-Dokumentation: ${name}`,
    goal ? `**Sprintziel:** ${goal}` : '',
    report.summary,
    '## Umgesetzt (Featureliste)',
    list(report.implemented.map((item) => `- ${item.kind === 'bug' ? '🐞 ' : ''}${item.title}`), '_Nichts umgesetzt._'),
    '## Offen / nicht umgesetzt',
    list(report.missing.map((item) => `- ${item.title} (${STATUS_DE[item.status] ?? item.status})`), '_Alles umgesetzt._'),
    '## Probleme',
    list(report.problems.map((item) => `- **${item.title}** – ${item.detail}`), '_Keine Probleme aufgetreten._'),
  ].filter(Boolean).join('\n\n');
}

/** Builds the sprint documentation from the real state of orders, agent runs, bugs and test runs. */
export async function generateSprintReport(pool: Pool, sprintId: string): Promise<SprintReport | null> {
  const sprint = await pool.query<{
    projectSlug: string; name: string; goal: string; startedAt: Date;
  }>(
    `SELECT project_slug AS "projectSlug", name, goal, COALESCE(start_date::timestamptz, created_at) AS "startedAt"
       FROM sprints WHERE id = $1`,
    [sprintId],
  );
  const info = sprint.rows[0];
  if (!info) {
    return null;
  }
  const orders = await pool.query<OrderRow>(
    `SELECT id, title, kind, status, effort_hours AS "effortHours" FROM development_items
      WHERE sprint_id = $1 ORDER BY created_at`,
    [sprintId],
  );
  const failures = await pool.query<{ developmentId: string; agentName: string; output: string }>(
    `SELECT DISTINCT ON (r.development_id) r.development_id AS "developmentId", st.agent_name AS "agentName", st.output
       FROM agent_runs r JOIN agent_run_steps st ON st.run_id = r.id AND st.status = 'failed'
      WHERE r.development_id = ANY($1::uuid[])
      ORDER BY r.development_id, r.started_at DESC, st.position`,
    [orders.rows.map((order) => order.id)],
  );
  const bugs = await pool.query<{ title: string; severity: string }>(
    `SELECT title, severity FROM bugs WHERE sprint_id = $1 AND status IN ('open', 'in_progress') ORDER BY created_at`,
    [sprintId],
  );
  const tests = await pool.query<{ failed: string; total: string }>(
    `SELECT COUNT(*) FILTER (WHERE status = 'failed') AS failed, COUNT(*) AS total
       FROM test_runs WHERE project_slug = $1 AND started_at >= $2`,
    [info.projectSlug, info.startedAt],
  );

  const done = orders.rows.filter((order) => order.status === 'done');
  const open = orders.rows.filter((order) => order.status !== 'done');
  const problems: SprintReport['problems'] = [];
  for (const order of orders.rows.filter((row) => row.status === 'blocked')) {
    const failure = failures.rows.find((row) => row.developmentId === order.id);
    problems.push({
      type: 'blocked',
      title: order.title,
      detail: failure
        ? `Agent „${failure.agentName}“ ist fehlgeschlagen: ${failure.output.trim().slice(-300)}`
        : 'Auftrag ist blockiert.',
    });
  }
  for (const bug of bugs.rows) {
    problems.push({ type: 'bug', title: bug.title, detail: `Offener Bug (${bug.severity}).` });
  }
  const failedTests = Number(tests.rows[0]?.failed ?? 0);
  if (failedTests > 0) {
    problems.push({
      type: 'tests', title: 'Fehlgeschlagene Testläufe', detail: `${failedTests} von ${tests.rows[0]?.total} Testläufen im Sprint sind fehlgeschlagen.`,
    });
  }
  const percent = orders.rows.length ? Math.round((done.length / orders.rows.length) * 100) : 0;
  const report: SprintReport = {
    sprintId,
    summary: `${done.length} von ${orders.rows.length} Aufträgen umgesetzt (${percent} %). ${open.length} offen, ${problems.length} Problem(e) dokumentiert.`,
    implemented: done.map(({ id, title, kind, effortHours }) => ({ id, title, kind, effortHours })),
    missing: open.map(({ id, title, status }) => ({ id, title, status })),
    problems,
  };
  await pool.query(
    `INSERT INTO sprint_reports (sprint_id, project_slug, summary, implemented, missing, problems)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (sprint_id) DO UPDATE
       SET summary = EXCLUDED.summary, implemented = EXCLUDED.implemented, missing = EXCLUDED.missing,
           problems = EXCLUDED.problems, generated_at = NOW()`,
    [sprintId, info.projectSlug, report.summary, JSON.stringify(report.implemented),
      JSON.stringify(report.missing), JSON.stringify(report.problems)],
  );
  await upsertDoc(pool, {
    projectSlug: info.projectSlug,
    kind: 'sprint',
    title: `Sprint: ${info.name}`,
    content: toMarkdown(info.name, info.goal, report),
    sprintId,
  });
  return report;
}

export function registerReportRoutes(app: Express, pool: Pool): void {
  app.get('/api/projects/:slug/sprint-reports', async (request, response) => {
    const slug = parseProjectSlug(request.params.slug ?? '');
    if (!slug) {
      response.status(400).json({ message: 'Invalid project slug.' });
      return;
    }
    const result = await pool.query(
      `SELECT r.sprint_id AS "sprintId", s.name AS "sprintName", s.status AS "sprintStatus", r.summary,
              r.implemented, r.missing, r.problems, r.notes, r.generated_at AS "generatedAt"
         FROM sprint_reports r JOIN sprints s ON s.id = r.sprint_id
        WHERE r.project_slug = $1 ORDER BY r.generated_at DESC`,
      [slug],
    );
    response.json({ reports: result.rows });
  });

  app.post('/api/sprints/:id/report', async (request, response) => {
    if (!isUuid(request.params.id)) {
      response.status(404).json({ message: 'Not found.' });
      return;
    }
    const report = await generateSprintReport(pool, request.params.id);
    if (!report) {
      response.status(404).json({ message: 'Sprint not found.' });
      return;
    }
    response.status(201).json({ report });
  });

  app.patch('/api/sprints/:id/report', async (request, response) => {
    const body = request.body as unknown;
    if (!isUuid(request.params.id) || !isRecord(body) || typeof body.notes !== 'string' || body.notes.length > 10_000) {
      response.status(400).json({ message: 'Invalid report notes.' });
      return;
    }
    const result = await pool.query(
      'UPDATE sprint_reports SET notes = $2 WHERE sprint_id = $1 RETURNING sprint_id',
      [request.params.id, body.notes.trim()],
    );
    if (!result.rows[0]) {
      response.status(404).json({ message: 'Kein Sprintbericht vorhanden.' });
      return;
    }
    response.json({ ok: true });
  });
}
