import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { ensureDefaultAgents, ensureReviewer } from '../../src/api/agents.js';
import { DEMO_BACKLOG, DEMO_IDEAS, DEMO_REJECTED, DEMO_SPRINTS } from './content.js';

/**
 * Beispielprojekt „Velowerk“ für die Testdatenbanken: ein Jahr Entwicklung in 25 Sprints mit Aufträgen, Bugs,
 * Ideen, Agent-Läufen, Kosten, Testläufen, Berichten und Doku. Alle Zeiten hängen am heutigen Datum, damit der
 * aktive Sprint immer gerade läuft. Zufall mit festem Startwert: Jeder Lauf erzeugt dieselben Daten.
 */
export const DEMO_SLUG = 'velowerk';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const MIN = 60_000;
/** Arbeitstage eines Sprints (Montag bis Freitag in zwei Wochen), als Tage ab Sprintbeginn. */
const WORKDAYS = [0, 1, 2, 3, 4, 7, 8, 9, 10, 11];
const ACTIVE = 24;
const CANCELLED = 11;
/** Ab diesem Sprint prüft der Reviewer, ab dem Sprint mit Review-Freigabe warten Oberflächen-Aufträge darauf. */
const REVIEWER_FROM = 13;
const APPROVAL_FROM = 18;
const LOCAL_DOCS_FROM = 15;

const CATEGORY: Record<string, string> = {
  fe: 'frontend',
  be: 'backend',
  fs: 'fullstack',
  in: 'infrastructure',
  do: 'docs',
  se: 'security',
};
const DEFINITION_OF_DONE = [
  'Alle Akzeptanzkriterien sind erfüllt.',
  'Build und alle Tests sind grün.',
  'Die Testabdeckung je Bereich liegt bei mindestens 75 % oder die Abweichung ist begründet.',
  'Neuer und geänderter Code ist durch Tests abgedeckt.',
  'Die Dokumentation ist aktualisiert, wo das Verhalten sich ändert.',
];
const BRANCHES = ['Zürich Kreis 4', 'Oerlikon', 'Winterthur'];
const DEVICES = [
  'iPad (10. Generation), Safari',
  'Windows-Laptop am Schalter, Edge',
  'iPhone 15, Safari',
  'Pixel 8, Chrome',
];
const PEOPLE = ['Lea Brunner', 'Marco Keller', 'Sandra Huber'];

type Status = 'backlog' | 'planned' | 'in_progress' | 'blocked' | 'approval' | 'done' | 'rejected';

interface Spec {
  kind: 'feature' | 'bug' | 'express';
  category: string;
  priority: 'low' | 'medium' | 'high';
  severity: 'low' | 'medium' | 'high' | 'critical';
  effort: number;
  title: string;
  context: string;
  criteria: string[];
}

interface Order extends Spec {
  id: string;
  sprintNo: number | null;
  sprintId: string | null;
  status: Status;
  createdAt: Date;
  completedAt: Date | null;
  ideaId: string | null;
  bugId: string | null;
  retried: boolean;
  approval: boolean;
  files: string[];
  commit: string | null;
  rank: number | null;
}

/** Zufall mit festem Startwert (mulberry32). */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const rng = random(20251124);
const between = (min: number, max: number): number => min + rng() * (max - min);
const int = (min: number, max: number): number => Math.floor(between(min, max + 1));
const pick = <T>(list: readonly T[]): T => list[Math.floor(rng() * list.length)]!;
const hex = (length: number): string => Array.from({ length }, () => Math.floor(rng() * 16).toString(16)).join('');

function parse(line: string): Spec {
  const [kind, category, priority, effort, title, context, criteria] = line.split('|');
  const critical = priority === 'critical';
  const prio = (critical ? 'high' : priority) as Spec['priority'];
  return {
    kind: kind === 'b' ? 'bug' : kind === 'x' ? 'express' : 'feature',
    category: CATEGORY[category!] ?? 'fullstack',
    priority: prio,
    severity: critical ? 'critical' : prio,
    effort: Number(effort),
    title: title!,
    context: context!,
    criteria: (criteria ?? '')
      .split(';')
      .map((entry) => entry.trim())
      .filter(Boolean),
  };
}

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/[^a-z0-9]+/g, '-')
    .split('-')
    .filter((word) => word.length > 2)
    .slice(0, 3)
    .join('-');
}

function filesFor(spec: Spec, area: string): string[] {
  const name = slugify(spec.title) || area;
  const fe = [
    `frontend/src/app/features/${area}/${name}.component.ts`,
    `frontend/src/app/features/${area}/${name}.component.spec.ts`,
  ];
  const be = [`backend/src/modules/${area}/${name}.service.ts`, `backend/src/modules/${area}/${name}.service.spec.ts`];
  switch (spec.category) {
    case 'frontend':
      return [...fe, `frontend/src/app/features/${area}/${name}.component.html`];
    case 'backend':
      return [...be, `backend/src/modules/${area}/${area}.controller.ts`];
    case 'fullstack':
      return [...be, ...fe, `backend/src/migrations/${int(17000, 17999)}-${name}.ts`];
    case 'infrastructure':
      return ['.github/workflows/ci.yml', 'docker-compose.yml', `infra/${name}.md`];
    case 'docs':
      return [`docs/handbuch/${area}.md`];
    default:
      return [...be, 'backend/src/auth/policies.ts'];
  }
}

function describe(spec: Spec): string {
  if (spec.kind === 'express') return `Express-Anfrage aus dem Dashboard-Chat:\n\n> ${spec.context}`;
  if (spec.kind === 'bug') {
    return [
      '## Beobachtung',
      spec.context,
      '',
      '## Erwartet',
      spec.criteria[0] ?? '',
      '',
      '## Umgebung',
      `- Filiale ${pick(BRANCHES)}`,
      `- ${pick(DEVICES)}`,
    ].join('\n');
  }
  return [
    '## Ziel',
    spec.context,
    '',
    '## Akzeptanzkriterien',
    ...spec.criteria.map((criterion, index) => `${index + 1}. ${criterion}`),
  ].join('\n');
}

function mondayOf(time: number): number {
  const date = new Date(time);
  const weekday = (date.getUTCDay() + 6) % 7;
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) - weekday * DAY;
}

interface Agent {
  id: string;
  name: string;
  role: string;
  phase: string;
}

interface StepPlan {
  agent: Agent;
  status: 'passed' | 'failed' | 'running';
  durationMs: number;
  tokens: number;
  cost: number;
  model: string;
  routingRule: string | null;
  output: string;
  progress?: string;
}

/** Erzeugt die Daten in einer Transaktion. Gibt es das Projekt schon, passiert nichts. */
export async function seedDemoProject(pool: Pool, folder: string, now = Date.now()): Promise<void> {
  const exists = await pool.query('SELECT 1 FROM projects WHERE slug = $1', [DEMO_SLUG]);
  if (exists.rowCount) return;
  const activeStart = mondayOf(now - 7 * DAY);
  const sprintStart = (no: number): number => activeStart + (no - ACTIVE) * 14 * DAY;
  const projectCreated = new Date(sprintStart(1) - 9 * DAY + 9 * HOUR);

  await pool.query(
    `INSERT INTO projects (slug, name, repository, description, guidelines, git_remote, sprint_mode, sprint_capacity_hours,
       review_mode, health_url, log_services, created_at)
     VALUES ($1, 'Velowerk', $2, $3, $4, 'git@github.com:velowerk/werkstatt.git', 'suggest', 60, 'ui',
       'https://velowerk.ch/api/health', '{backend,frontend}', $5)`,
    [
      DEMO_SLUG,
      folder,
      'Werkstatt- und Buchungsplattform der Velowerk GmbH mit drei Filialen (Zürich Kreis 4, Oerlikon, Winterthur): Online-Termine, Reparaturaufträge, Lager, Kasse und Kundenportal.',
      [
        '## Do',
        '- Angular 20 mit Signals im Frontend, NestJS und PostgreSQL im Backend.',
        '- Beträge in Rappen als Ganzzahl speichern, auf 5 Rappen runden.',
        '- Zeiten immer in Europe/Zurich rechnen.',
        '- Jede neue Funktion mit Unit-Test, Abläufe mit Playwright.',
        '',
        "## Don't",
        '- Keine Personendaten an Dritte (Tracking-Pixel, Analytics ohne Einwilligung).',
        '- Preise und Rechnungen nie ohne Audit-Log ändern.',
        '- Keine Zahlungsdaten in Logs.',
      ].join('\n'),
      projectCreated,
    ],
  );
  await ensureDefaultAgents(pool, DEMO_SLUG);
  await ensureReviewer(pool, DEMO_SLUG);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await fill(client, { now, sprintStart });
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function fill(
  db: PoolClient,
  { now, sprintStart }: { now: number; sprintStart: (no: number) => number },
): Promise<void> {
  const agents = (
    await db.query<Agent>('SELECT id, name, role, phase FROM agents WHERE project_slug = $1', [DEMO_SLUG])
  ).rows;
  const byRole = (role: string): Agent => agents.find((agent) => agent.role === role)!;

  // ---- Sprints -------------------------------------------------------------------------------------------
  const sprintIds = DEMO_SPRINTS.map(() => randomUUID());
  const orders: Order[] = [];
  const ideas: { id: string; title: string; source: string; createdAt: Date }[] = [];

  DEMO_SPRINTS.forEach((sprint, index) => {
    const no = index + 1;
    const start = sprintStart(no);
    sprint.items.forEach((line, position) => {
      const spec = parse(line);
      let status: Status;
      let sprintId: string | null = sprintIds[index]!;
      if (no < ACTIVE && no !== CANCELLED) status = 'done';
      else if (no === CANCELLED) {
        status = position === 0 ? 'done' : 'backlog';
        if (position > 0) sprintId = null;
      } else if (no === ACTIVE) {
        status = (['done', 'done', 'done', 'done', 'done', 'approval', 'in_progress', 'blocked'][position] ??
          'planned') as Status;
      } else status = 'planned';
      const created =
        spec.kind === 'express'
          ? start + pick(WORKDAYS.slice(0, 5)) * DAY + between(7, 9) * HOUR
          : start - between(spec.kind === 'bug' ? 1 : 4, spec.kind === 'bug' ? 9 : 35) * DAY + between(7, 16) * HOUR;
      const order: Order = {
        ...spec,
        id: randomUUID(),
        sprintNo: no,
        sprintId,
        status,
        createdAt: new Date(Math.max(created, sprintStart(1) - 8 * DAY)),
        completedAt: null,
        ideaId: null,
        bugId: spec.kind === 'bug' ? randomUUID() : null,
        retried: status === 'done' && spec.kind === 'feature' && spec.effort >= 3 && rng() < 0.17,
        approval: no >= APPROVAL_FROM && (spec.category === 'frontend' || spec.category === 'fullstack'),
        files: filesFor(spec, sprint.area),
        commit: null,
        rank: no >= ACTIVE ? position : null,
      };
      // Die grösseren Features entstanden aus Ideen (Mensch oder Visionär).
      if (spec.kind === 'feature' && position < 2) {
        const idea = {
          id: randomUUID(),
          title: spec.title,
          source: position === 0 && no % 3 === 0 ? 'visionary' : 'human',
          createdAt: new Date(order.createdAt.getTime() - between(1, 12) * DAY),
        };
        ideas.push(idea);
        order.ideaId = idea.id;
      }
      orders.push(order);
    });
  });
  const extra = (lines: string[], status: Status) =>
    lines.forEach((line) => {
      const spec = parse(line);
      orders.push({
        ...spec,
        id: randomUUID(),
        sprintNo: null,
        sprintId: null,
        status,
        createdAt: new Date(now - between(5, 120) * DAY),
        completedAt: null,
        ideaId: null,
        bugId: spec.kind === 'bug' ? randomUUID() : null,
        retried: false,
        approval: false,
        files: [],
        commit: null,
        rank: null,
      });
    });
  extra(DEMO_BACKLOG, 'backlog');
  extra(DEMO_REJECTED, 'rejected');

  for (const [index, sprint] of DEMO_SPRINTS.entries()) {
    const no = index + 1;
    const start = sprintStart(no);
    const end = start + 13 * DAY;
    const status = no === CANCELLED ? 'cancelled' : no < ACTIVE ? 'completed' : no === ACTIVE ? 'active' : 'planned';
    const done = status === 'completed';
    await db.query(
      `INSERT INTO sprints (id, project_slug, name, goal, status, start_date, end_date, git_sync, git_action, git_commit,
         git_branch, git_synced_at, pre_sprint_at, pre_sprint_notes, review_ready_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6::timestamptz::date, $7::timestamptz::date, $8, 'push', $9, $10, $11, $12, $13, $14, $15, $16)`,
      [
        sprintIds[index],
        DEMO_SLUG,
        `Sprint ${no} · ${sprint.name}`,
        sprint.goal,
        status,
        new Date(start + 12 * HOUR),
        new Date(end + 12 * HOUR),
        done ? 'done' : null,
        done ? hex(40) : null,
        status === 'planned' ? null : `sprint/sprint-${no}`,
        done ? new Date(end + 1 * DAY + 6 * HOUR) : null,
        status === 'planned' ? null : new Date(start + 6.5 * HOUR),
        status === 'planned'
          ? null
          : `Vorbereitung: ${sprint.items.length} Aufträge geprüft, Reihenfolge nach Abhängigkeiten (${sprint.areaLabel}).`,
        done ? new Date(end - 2 * DAY + 15 * HOUR) : null,
        new Date(start - 6 * DAY + 10 * HOUR),
        new Date(done ? end + DAY : Math.min(now, start + DAY)),
      ],
    );
  }

  // ---- Ideen ------------------------------------------------------------------------------------------------
  for (const idea of ideas) {
    await db.query(
      `INSERT INTO ideation_items (id, project_slug, title, description, status, priority, source, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'accepted', 'medium', $5, $6, $6)`,
      [idea.id, DEMO_SLUG, idea.title, `Idee: ${idea.title}.`, idea.source, idea.createdAt],
    );
  }
  for (const [index, [title, description, status, source]] of DEMO_IDEAS.entries()) {
    const id = randomUUID();
    const createdAt = new Date(now - (index + 1) * between(2, 6) * DAY);
    await db.query(
      `INSERT INTO ideation_items (id, project_slug, title, description, status, priority, source, benefit, cost,
         effort_hours, rejection_reason, external_ref, progress, progress_agent, drafting_started_at, category, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $17)`,
      [
        id,
        DEMO_SLUG,
        title,
        description,
        status,
        pick(['low', 'medium', 'high']),
        source,
        int(3, 9),
        int(2, 8),
        pick([4, 6, 8, 12, 16]),
        status === 'rejected' ? 'Passt nicht zur Marke: Im Kundenportal gibt es keine Werbung.' : null,
        source === 'github' ? 'velowerk/werkstatt#212' : null,
        status === 'drafting' ? 'Auftragsautor schreibt Akzeptanzkriterien …' : null,
        status === 'drafting' ? 'Auftragsautor' : null,
        status === 'drafting' ? new Date(now - 3 * MIN) : null,
        pick(['frontend', 'fullstack', 'backend']),
        createdAt,
      ],
    );
    if (index < 3) {
      const comment = randomUUID();
      await db.query(
        `INSERT INTO ideation_comments (id, ideation_id, author, body, created_at) VALUES ($1, $2, $3, $4, $5)`,
        [
          comment,
          id,
          pick(PEOPLE),
          pick([
            'Hab mit der Filiale Oerlikon gesprochen – die wären sofort dabei.',
            'Klingt gut, aber erst nach dem Offline-Modus.',
            'Können wir das mit zwei Firmenkunden testen, bevor wir es bauen?',
          ]),
          new Date(createdAt.getTime() + 5 * HOUR),
        ],
      );
    }
  }

  // ---- Aufträge, Bugs, Läufe ------------------------------------------------------------------------------
  const developer = byRole('developer');
  const tester = byRole('tester');
  const reviewer = byRole('reviewer');
  const documenter = byRole('documenter');
  const manual = byRole('manual_writer');
  const userManual = byRole('user_manual_writer');
  const author = byRole('author');
  const bugReviewer = byRole('bug_reviewer');
  const sprintCounter = new Map<number, number>();
  const usage: [string, number, number, number, Date][] = [];

  for (const order of orders) {
    const sprint = order.sprintNo ? DEMO_SPRINTS[order.sprintNo - 1]! : null;
    const no = order.sprintNo ?? ACTIVE;
    const start = order.sprintNo ? sprintStart(order.sprintNo) : 0;
    const slot = sprintCounter.get(no) ?? 0;
    sprintCounter.set(no, slot + 1);
    const total = sprint?.items.length ?? 1;
    // Zeitpunkt des (ersten) Laufs: über die Arbeitstage verteilt, im aktiven Sprint nur in der ersten Woche.
    const days = no === ACTIVE ? [0, 1, 2, 3, 4] : WORKDAYS;
    let runStart =
      start +
      days[Math.min(days.length - 1, Math.floor((slot * days.length) / total))]! * DAY +
      between(6.5, 14) * HOUR;
    if (order.status === 'approval') runStart = now - between(3.5, 5) * HOUR;
    if (order.status === 'in_progress') runStart = now - 38 * MIN;
    if (order.status === 'blocked') runStart = start + 4 * DAY + 13 * HOUR;
    if (order.kind === 'express') runStart = Math.max(runStart, order.createdAt.getTime() + 20 * MIN);

    const runs =
      order.status === 'done' ||
      order.status === 'approval' ||
      order.status === 'in_progress' ||
      order.status === 'blocked';
    const events: [string, string, number][] = [['created', 'backlog', order.createdAt.getTime()]];
    if (order.sprintId || order.status === 'done') {
      let planned = Math.min(Math.max(order.createdAt.getTime() + 10 * MIN, start + 6 * HOUR), runStart - 5 * MIN);
      // Der nächste Sprint ist schon geplant: eingeplant in den letzten Tagen, nicht erst an seinem Start.
      if (planned > now) planned = now - between(20, 50) * HOUR;
      events.push(['status', 'backlog>planned', planned]);
    }
    if (order.status === 'rejected') events.push(['status', 'backlog>rejected', order.createdAt.getTime() + 2 * HOUR]);

    const plans: { at: number; status: 'passed' | 'failed' | 'running'; steps: StepPlan[] }[] = [];
    let failureText: string | null = null;
    let analysis = '';
    if (runs) {
      const unmetReason = pick([
        'Der Test für den Fehlerfall fehlt',
        'Auf 375 px Breite ist der Knopf abgeschnitten',
        'Die Meldung erscheint nur auf Englisch',
        'Bei 2000 Einträgen dauert das Laden 1.8 s',
        'Ein Unit-Test schlägt fehl: erwartet 47.55, erhalten 47.53',
      ]);
      const sequence = (final: 'passed' | 'failed-tester' | 'running-tester' | 'review'): StepPlan[] => {
        const steps: StepPlan[] = [];
        const unit = 40 + no * 19 + slot;
        const e2e = 4 + no * 2;
        if (order.ideaId) steps.push(plan(author, 'author', order, no, 'passed'));
        if (order.kind === 'bug') steps.push(plan(bugReviewer, 'bug_reviewer', order, no, 'passed'));
        steps.push(plan(developer, 'developer', order, no, 'passed'));
        if (final === 'failed-tester') {
          steps.push(plan(tester, 'tester', order, no, 'failed', { unit, e2e, unmetReason }));
          return steps;
        }
        if (final === 'running-tester') {
          const step = plan(tester, 'tester', order, no, 'running', { unit, e2e });
          step.progress = `Tests laufen: ${Math.floor(unit * 0.66)} von ${unit} · ${Math.floor(unit * 0.66)} ✓`;
          steps.push(step);
          return steps;
        }
        steps.push(plan(tester, 'tester', order, no, 'passed', { unit, e2e }));
        if (order.kind === 'express') return steps;
        if (no >= REVIEWER_FROM) steps.push(plan(reviewer, 'reviewer', order, no, 'passed'));
        steps.push(plan(documenter, 'documenter', order, no, 'passed'));
        steps.push(plan(manual, 'manual_writer', order, no, 'passed'));
        if (order.category === 'frontend' || order.category === 'fullstack')
          steps.push(plan(userManual, 'user_manual_writer', order, no, 'passed'));
        return steps;
      };
      if (order.retried) {
        plans.push({ at: runStart, status: 'failed', steps: sequence('failed-tester') });
        plans.push({ at: runStart + between(16, 22) * HOUR, status: 'passed', steps: sequence('passed') });
      } else if (order.status === 'blocked') {
        plans.push({ at: runStart, status: 'failed', steps: sequence('failed-tester') });
      } else if (order.status === 'in_progress') {
        plans.push({ at: runStart, status: 'running', steps: sequence('running-tester') });
      } else plans.push({ at: runStart, status: 'passed', steps: sequence('passed') });

      for (const [index, run] of plans.entries()) {
        const runId = randomUUID();
        let cursor = run.at;
        events.push(['status', 'planned>in_progress', run.at]);
        // agent_runs braucht den Auftrag (Fremdschlüssel): Läufe werden nach dem Auftrag geschrieben (writeRuns).
        pendingRuns.push({ runId, order, run, cursorStart: cursor });
        for (const step of run.steps) cursor += step.durationMs + between(8, 40) * 1000;
        const end = cursor;
        if (run.status === 'failed') {
          events.push(['status', 'in_progress>blocked', end]);
          if (order.status !== 'blocked' || index > 0) {
            events.push(['analysis', 'requested', end + 2000]);
            events.push(['analysis', 'running', end + 20_000]);
            events.push(['analysis', 'done', end + between(60, 160) * 1000]);
            events.push(['status', 'blocked>planned', plans[index + 1]!.at - 4 * MIN]);
            usage.push(['analyst', int(6000, 14000), int(20000, 60000), 0.2, new Date(end + 30_000)]);
          }
        } else if (run.status === 'passed') {
          if (order.approval) {
            events.push(['status', 'in_progress>approval', end]);
            if (order.status === 'done') {
              const approved = end + between(1.5, 20) * HOUR;
              events.push(['status', 'approval>done', approved]);
              order.completedAt = new Date(approved);
            }
          } else {
            events.push(['status', 'in_progress>done', end]);
            order.completedAt = new Date(end);
          }
        }
      }
      if (order.status === 'blocked') {
        const end = plans[0]!.steps.reduce((sum, step) => sum + step.durationMs + 20_000, plans[0]!.at);
        failureText = blockedFailure();
        analysis = blockedAnalysis();
        events.push(
          ['analysis', 'requested', end + 2000],
          ['analysis', 'running', end + 15_000],
          ['analysis', 'done', end + 95_000],
        );
        usage.push(['analyst', 11234, 48000, 0.22, new Date(end + 30_000)]);
      }
    }
    if (order.status === 'done') order.commit = hex(40);

    // Bug zum Bug-Auftrag
    if (order.bugId) {
      const source =
        order.sprintNo === null
          ? 'manual'
          : pick(['manual', 'manual', 'manual', 'production', 'production', 'test', 'agent']);
      await db.query(
        `INSERT INTO bugs (id, project_slug, title, description, severity, status, source, sprint_id, fix_notes, category,
           created_at, updated_at, fixed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
          order.bugId,
          DEMO_SLUG,
          order.title,
          describe(order),
          order.severity,
          order.status === 'done'
            ? 'fixed'
            : order.status === 'blocked' || order.status === 'in_progress'
              ? 'in_progress'
              : 'open',
          source,
          order.sprintId,
          order.status === 'done'
            ? `Behoben in Sprint ${order.sprintNo}: ${order.criteria[0] ?? 'siehe Auftrag'}.`
            : '',
          order.category,
          new Date(order.createdAt.getTime() - 40 * MIN),
          order.completedAt ?? order.createdAt,
          order.completedAt,
        ],
      );
      usage.push([
        'bug_reviewer',
        int(1800, 3800),
        int(9000, 30000),
        0.06,
        new Date(order.createdAt.getTime() - 30 * MIN),
      ]);
    }
    if (order.kind === 'feature') usage.push(['author', int(8000, 17000), int(25000, 70000), 0.07, order.createdAt]);

    await db.query(
      `INSERT INTO development_items (id, project_slug, ideation_id, sprint_id, bug_id, title, description, kind, status,
         priority, effort_hours, token_estimate, benefit, cost, category, failure, retry_count, analysis_status, analysis,
         sprint_rank, git_commit, changed_files, review_branch, review_base, review_since, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23,
         $24, $25, $26, $27)`,
      [
        order.id,
        DEMO_SLUG,
        order.ideaId,
        order.sprintId,
        order.bugId,
        order.title,
        describe(order),
        order.kind,
        order.status,
        order.priority,
        order.effort,
        Math.round(order.effort * 520_000),
        order.kind === 'feature' ? int(4, 9) : null,
        order.kind === 'feature' ? int(2, 7) : null,
        order.category,
        failureText,
        order.retried ? 1 : 0,
        order.retried || order.status === 'blocked' ? 'done' : null,
        analysis || (order.retried ? retryAnalysis(order) : ''),
        order.rank,
        order.commit,
        runs ? order.files : [],
        order.status === 'approval' ? `auftrag/${order.id.slice(0, 8)}-${slugify(order.title)}` : null,
        order.status === 'approval' ? `sprint/sprint-${order.sprintNo}` : null,
        order.status === 'approval' ? new Date(now - 3 * HOUR) : null,
        order.createdAt,
        order.completedAt ?? new Date(Math.max(...events.map((event) => event[2]))),
      ],
    );
    if (order.completedAt) {
      await db.query('UPDATE development_items SET completed_at = $2 WHERE id = $1', [order.id, order.completedAt]);
    }
    // Zeitleiste: die vom Trigger mit „jetzt“ geschriebenen Einträge durch die echte Geschichte ersetzen.
    await db.query('DELETE FROM development_events WHERE development_id = $1', [order.id]);
    for (const [kind, detail, at] of events.sort((a, b) => a[2] - b[2])) {
      await db.query('INSERT INTO development_events (development_id, at, kind, detail) VALUES ($1, $2, $3, $4)', [
        order.id,
        new Date(at),
        kind,
        detail,
      ]);
    }
    await writeRuns(db, order);
    await writeChecks(db, order, now);
  }

  // ---- Weitere Bugs, Verbrauch, Berichte, Doku, Tests, Betrieb, Chat, Git -------------------------------------
  const standalone = await writeStandaloneBugs(db, now);
  for (const no of DEMO_SPRINTS.keys()) {
    const at = sprintStart(no + 1) + 6.5 * HOUR;
    if (at < now) usage.push(['pre_sprint', int(25000, 48000), int(60000, 140000), 0.4, new Date(at)]);
  }
  for (let day = 0; day < 330; day += int(1, 4)) {
    const at = now - day * DAY - between(1, 8) * HOUR;
    usage.push(['assistant', int(1500, 6000), int(8000, 40000), between(0.3, 1.4), new Date(at)]);
  }
  for (const [role, tokens, duration, cost, at] of usage) {
    await db.query(
      `INSERT INTO agent_usage (project_slug, role, tokens, duration_ms, cost_usd, success, created_at) VALUES ($1, $2, $3, $4, $5, TRUE, $6)`,
      [DEMO_SLUG, role, tokens, duration, cost.toFixed(4), at],
    );
  }
  await writeReportsAndDocs(db, orders, sprintIds, sprintStart, now);
  await writeTestRuns(db, orders, sprintStart, now);
  await writeProduction(db, orders, sprintStart, standalone, now);
  await writeChat(db, orders, now);
  await writeGitGraph(db, orders, sprintStart, now);
  await db.query(
    `INSERT INTO budgets (project_slug, period, max_tokens, max_cost_usd) VALUES ($1, 'day', NULL, 12), ($1, 'sprint', NULL, 40)`,
    [DEMO_SLUG],
  );
  await db.query(
    `INSERT INTO visionary_runs (project_slug, status, progress, created_count, discarded_count, requested_by, requested_at, started_at, finished_at, focus)
     VALUES ($1, 'done', NULL, 4, 2, 'Lea Brunner', $2, $2, $3, 'Wintersaison'),
            ($1, 'done', NULL, 3, 1, 'Marco Keller', $4, $4, $5, NULL)`,
    [
      DEMO_SLUG,
      new Date(now - 9 * DAY),
      new Date(now - 9 * DAY + 4 * MIN),
      new Date(now - 60 * DAY),
      new Date(now - 60 * DAY + 3 * MIN),
    ],
  );
}

/** Läufe, die erst nach dem Auftrag geschrieben werden können (Fremdschlüssel). */
const pendingRuns: {
  runId: string;
  order: Order;
  run: { at: number; status: 'passed' | 'failed' | 'running'; steps: StepPlan[] };
  cursorStart: number;
}[] = [];

async function writeRuns(db: PoolClient, order: Order): Promise<void> {
  for (const pending of pendingRuns.filter((entry) => entry.order === order)) {
    await db.query(
      `INSERT INTO agent_runs (id, project_slug, development_id, status, started_at) VALUES ($1, $2, $3, 'running', $4)`,
      [pending.runId, DEMO_SLUG, order.id, new Date(pending.run.at)],
    );
    let cursor = pending.cursorStart;
    for (const [position, step] of pending.run.steps.entries()) {
      const started = cursor;
      cursor += step.durationMs + between(8, 40) * 1000;
      await db.query(
        `INSERT INTO agent_run_steps (run_id, position, agent_id, agent_name, phase, status, exit_code, duration_ms, output,
           progress, tokens, cost_usd, model, routing_rule, started_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [
          pending.runId,
          position,
          step.agent.id,
          step.agent.name,
          step.agent.phase,
          step.status,
          step.status === 'running' ? null : step.status === 'passed' ? 0 : 1,
          step.status === 'running' ? null : step.durationMs,
          step.output,
          step.progress ?? null,
          step.tokens,
          step.cost.toFixed(4),
          step.model,
          step.routingRule,
          new Date(started),
        ],
      );
    }
    await db.query('UPDATE agent_runs SET status = $2, completed_at = $3 WHERE id = $1', [
      pending.runId,
      pending.run.status,
      pending.run.status === 'running' ? null : new Date(cursor),
    ]);
  }
  pendingRuns.splice(0, pendingRuns.length, ...pendingRuns.filter((entry) => entry.order !== order));
}

function plan(
  agent: Agent,
  role: string,
  order: Order,
  no: number,
  status: 'passed' | 'failed' | 'running',
  tests?: { unit: number; e2e: number; unmetReason?: string },
): StepPlan {
  const files = order.files;
  const local = no >= LOCAL_DOCS_FROM && (role === 'manual_writer' || role === 'user_manual_writer');
  const price: Record<string, number> = { opus: 2.57, sonnet: 0.92, haiku: 0.157, local: 0 };
  let tier: keyof typeof price = 'sonnet';
  let tokens = int(150_000, 600_000);
  let duration = between(2, 9) * MIN;
  let output = '';
  switch (role) {
    case 'developer': {
      tier = order.effort <= 1 ? 'sonnet' : 'opus';
      tokens = Math.round(Math.max(220_000, order.effort * between(170_000, 330_000)));
      duration = Math.max(3 * MIN, order.effort * between(2.5, 5) * MIN);
      output = [
        pick([`Ich habe „${order.title}“ umgesetzt.`, `„${order.title}“ ist umgesetzt.`, `Umgesetzt: ${order.title}.`]),
        '',
        '## Änderungen',
        ...files.map((file) => `- \`${file}\``),
        '',
        '## Tests',
        `- ${int(2, 9)} neue Tests, alle grün`,
        '- Typecheck und Lint ohne Fehler',
      ].join('\n');
      break;
    }
    case 'tester': {
      const unit = tests?.unit ?? 100;
      const e2e = tests?.e2e ?? 10;
      if (status === 'failed') {
        output = [
          'Abnahme nicht bestanden.',
          '',
          `- AK ${order.criteria.length > 1 ? 2 : 1} „${order.criteria[order.criteria.length > 1 ? 1 : 0] ?? order.title}“: ${tests?.unmetReason ?? 'nicht erfüllt'}`,
          '',
          `Unit: ${unit - 1} von ${unit} bestanden · E2E: ${e2e} von ${e2e} bestanden`,
        ].join('\n');
      } else if (status === 'passed') {
        output = [
          'Alle Akzeptanzkriterien sind erfüllt.',
          '',
          `- Unit: ${unit} von ${unit} bestanden`,
          `- E2E: ${e2e} von ${e2e} bestanden`,
          `- Abdeckung Backend ${Math.min(88, 55 + no * 1.2).toFixed(1)} %, Frontend ${Math.min(86, 48 + no * 1.4).toFixed(1)} %`,
        ].join('\n');
      }
      break;
    }
    case 'reviewer':
      tokens = int(80_000, 260_000);
      duration = between(1, 4) * MIN;
      output = `Code-Review ohne Einwände.\n\n- ${pick(['Fehlerfälle sind abgedeckt', 'Benennung ist konsistent mit dem Modul', 'Keine Personendaten in Logs'])}\n- ${pick(['Kleine Duplizierung im Test – akzeptabel', 'Migration ist rückwärtskompatibel', 'Keine neuen Abhängigkeiten'])}`;
      break;
    case 'author':
      tier = 'haiku';
      tokens = int(40_000, 95_000);
      duration = between(40, 120) * 1000;
      output = `Auftrag aus der Idee geschrieben: ${order.criteria.length} Akzeptanzkriterien, Schätzung ${order.effort} h.`;
      break;
    case 'bug_reviewer':
      tier = 'haiku';
      tokens = int(20_000, 60_000);
      duration = between(20, 60) * 1000;
      output = `Bug geprüft: reproduzierbar. Ursache wahrscheinlich in \`${files[0] ?? 'backend'}\`. Freigegeben für den Entwickler.`;
      break;
    default:
      tier = local ? 'local' : 'haiku';
      tokens = int(30_000, 120_000);
      duration = between(30, 150) * 1000;
      output =
        role === 'documenter'
          ? `Dokumentation ergänzt: Abschnitt „${order.title}“.`
          : role === 'manual_writer'
            ? 'Anwendungshandbuch aktualisiert.'
            : 'Benutzerhandbuch aktualisiert: Bedienung Schritt für Schritt ergänzt.';
  }
  if (status === 'running') duration = 6 * MIN;
  const model = tier === 'local' ? 'ollama (qwen3-coder:30b)' : `claude (${tier})`;
  return {
    agent,
    status,
    durationMs: Math.round(duration),
    tokens,
    cost: (tokens / 1_000_000) * price[tier]!,
    model,
    routingRule: tier === 'local' ? 'Doku lokal' : null,
    output,
  };
}

async function writeChecks(db: PoolClient, order: Order, now: number): Promise<void> {
  if (!['done', 'approval', 'blocked', 'in_progress'].includes(order.status) || order.kind === 'express') return;
  const at = order.completedAt ?? new Date(now - 2 * HOUR);
  const open = order.status === 'in_progress';
  for (const [index, text] of order.criteria.entries()) {
    const unmet = order.status === 'blocked' && index === 1;
    await db.query(
      `INSERT INTO acceptance_checks (development_id, kind, position, text, status, note, checked_at) VALUES ($1, 'criterion', $2, $3, $4, $5, $6)`,
      [
        order.id,
        index + 1,
        text,
        open ? 'open' : unmet ? 'unmet' : 'met',
        open
          ? ''
          : unmet
            ? 'Das Diagramm gruppiert nach Kalenderwoche statt nach Monat'
            : pick([
                'Per Unit-Test belegt',
                'Im E2E-Test geprüft',
                'Manuell in der Vorschau geprüft',
                'Per Test und Screenshot belegt',
              ]),
        at,
      ],
    );
  }
  for (const [index, text] of DEFINITION_OF_DONE.entries()) {
    const unmet = order.status === 'blocked' && index === 1;
    await db.query(
      `INSERT INTO acceptance_checks (development_id, kind, position, text, status, note, checked_at) VALUES ($1, 'done', $2, $3, $4, $5, $6)`,
      [order.id, index + 1, text, open ? 'open' : unmet ? 'unmet' : 'met', unmet ? '1 Test schlägt fehl' : '', at],
    );
  }
}

function blockedFailure(): string {
  return [
    'Agent „Tester“ scheiterte:',
    '',
    'Das Dashboard zeigt Durchschnitt und Kommentare je Filiale, aber der Monatstrend fehlt: Die Abfrage gruppiert nach Kalenderwoche. Für Winterthur gibt es vor August keine Bewertungen, dort bleibt das Diagramm leer.',
    '',
    '## Abnahme nicht bestanden',
    '- AK 2 „Trend je Monat“: Das Diagramm gruppiert nach Kalenderwoche statt nach Monat',
    '- DoD 2 „Build und alle Tests sind grün.“: reviews-trend.spec.ts schlägt fehl (erwartet 6 Monate, erhalten 26 Wochen)',
    '',
    '## Testlauf',
    '✓ 512 bestanden · ✗ 1 fehlgeschlagen',
    '  ✗ ReviewsTrend › gruppiert nach Monat',
  ].join('\n');
}

function blockedAnalysis(): string {
  return [
    '## Ursache',
    "`ReviewStatsService.trend()` gruppiert mit `date_trunc('week', created_at)`, das Kriterium verlangt Monate. Der fehlschlagende Test ist korrekt.",
    '',
    '## Lösung',
    "1. In `backend/src/modules/abholung/review-stats.service.ts` nach `date_trunc('month', created_at)` gruppieren und Monate ohne Bewertung mit 0 auffüllen.",
    '2. Im Frontend die Achse auf Monatsnamen umstellen (Format „MMM yyyy“).',
  ].join('\n');
}

function retryAnalysis(order: Order): string {
  return [
    '## Ursache',
    `Der Tester lehnte im ersten Lauf ab: Ein Akzeptanzkriterium von „${order.title}“ war nicht vollständig umgesetzt.`,
    '',
    '## Lösung',
    '1. Fehlenden Fall ergänzen und mit einem Test belegen.',
  ].join('\n');
}

async function writeStandaloneBugs(db: PoolClient, now: number): Promise<string> {
  const calendar = randomUUID();
  const rows: [string, string, string, string, string, string, number][] = [
    [
      calendar,
      'TypeError im Buchungskalender bei Filiale ohne Öffnungszeiten',
      'Seit dem letzten Deploy melden 37 Besuche einen Fehler, wenn eine Filiale für den gewählten Tag keine Öffnungszeiten hat.',
      'high',
      'open',
      'production',
      2,
    ],
    [
      randomUUID(),
      'Logo im Rechnungs-PDF unscharf',
      'Auf gedruckten Rechnungen wirkt das Logo pixelig.',
      'low',
      'open',
      'manual',
      6,
    ],
    [
      randomUUID(),
      'Portal bleibt im Internet Explorer 11 leer',
      'Ein Kunde meldet eine leere Seite im IE 11.',
      'low',
      'wontfix',
      'manual',
      40,
    ],
    [
      randomUUID(),
      'E2E-Test „Kundenportal Anmeldung“ instabil',
      'Der Test scheitert etwa jedes zehnte Mal mit einem Timeout beim Öffnen des Links.',
      'medium',
      'open',
      'test',
      4,
    ],
  ];
  for (const [id, title, description, severity, status, source, days] of rows) {
    await db.query(
      `INSERT INTO bugs (id, project_slug, title, description, severity, status, source, category, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'frontend', $8, $8)`,
      [id, DEMO_SLUG, title, description, severity, status, source, new Date(now - days * DAY)],
    );
  }
  return calendar;
}

async function writeReportsAndDocs(
  db: PoolClient,
  orders: Order[],
  sprintIds: string[],
  sprintStart: (no: number) => number,
  now: number,
): Promise<void> {
  for (const [index, sprint] of DEMO_SPRINTS.entries()) {
    const no = index + 1;
    if (no >= ACTIVE || no === CANCELLED) continue;
    const items = orders.filter((order) => order.sprintNo === no);
    const retries = items.filter((order) => order.retried);
    const end = sprintStart(no) + 13 * DAY;
    await db.query(
      `INSERT INTO sprint_reports (sprint_id, project_slug, summary, implemented, missing, problems, notes, generated_at)
       VALUES ($1, $2, $3, $4, '[]', $5, '', $6)`,
      [
        sprintIds[index],
        DEMO_SLUG,
        `${items.length} von ${items.length} Aufträgen umgesetzt (100 %).${retries.length ? ` ${retries.length} Problem(e) dokumentiert.` : ''}`,
        JSON.stringify(
          items.map((order) => ({ id: order.id, kind: order.kind, title: order.title, effortHours: order.effort })),
        ),
        JSON.stringify(
          retries.map((order) => ({
            type: 'retry',
            title: order.title,
            detail: 'Der Tester lehnte im ersten Lauf ab, der zweite Lauf war grün.',
          })),
        ),
        new Date(end - 2 * DAY + 16 * HOUR),
      ],
    );
    await db.query(
      `INSERT INTO docs (project_slug, kind, title, content, sprint_id, created_at, updated_at) VALUES ($1, 'sprint', $2, $3, $4, $5, $5)`,
      [
        DEMO_SLUG,
        `Sprint: Sprint ${no} · ${sprint.name}`,
        [
          `# Sprint ${no} · ${sprint.name}`,
          '',
          `**Ziel:** ${sprint.goal}`,
          '',
          '## Umgesetzt',
          ...items.map((order) => `- ${order.kind === 'bug' ? '🐞 ' : ''}${order.title}`),
          ...(retries.length
            ? [
                '',
                '## Probleme',
                ...retries.map((order) => `- ${order.title}: erster Testlauf abgelehnt, im zweiten Lauf grün`),
              ]
            : []),
        ].join('\n'),
        sprintIds[index],
        new Date(end - 2 * DAY + 16 * HOUR),
      ],
    );
  }
  // Auftragsdoku der letzten Sprints (vom Dokumentierer).
  for (const order of orders.filter(
    (entry) => entry.status === 'done' && (entry.sprintNo ?? 0) >= 18 && entry.kind !== 'express',
  )) {
    await db.query(
      `INSERT INTO docs (project_slug, kind, title, content, development_id, created_at, updated_at) VALUES ($1, 'order', $2, $3, $4, $5, $5)`,
      [
        DEMO_SLUG,
        order.title,
        [
          `# ${order.title}`,
          '',
          order.context,
          '',
          '## Umsetzung',
          ...order.files.map((file) => `- \`${file}\``),
          '',
          '## Abnahme',
          ...order.criteria.map((criterion) => `- ✓ ${criterion}`),
        ].join('\n'),
        order.id,
        order.completedAt,
      ],
    );
  }
  const chapters = DEMO_SPRINTS.slice(0, ACTIVE - 1).filter((_, index) => index + 1 !== CANCELLED);
  const technical = [
    '# Anwendungshandbuch Velowerk',
    '',
    '## Architektur',
    '',
    '| Schicht | Technik |',
    '|---|---|',
    '| Frontend | Angular 20, Signals, PWA |',
    '| Backend | NestJS 11, TypeORM |',
    '| Datenbank | PostgreSQL 17 |',
    '| Betrieb | Docker Compose auf Hetzner, Sentry, nächtliches Backup |',
    '',
    ...chapters.flatMap((sprint) => [`## ${sprint.areaLabel}`, '', sprint.goal, '']),
  ].join('\n');
  const user = [
    '# Benutzerhandbuch',
    '',
    'Dieses Handbuch beschreibt die Arbeit mit Velowerk am Schalter, in der Werkstatt und im Kundenportal.',
    '',
    ...chapters.flatMap((sprint) => [
      `## ${sprint.areaLabel}`,
      '',
      `So arbeitest du mit „${sprint.name}“: ${sprint.goal}`,
      '',
    ]),
  ].join('\n');
  for (const [title, content] of [
    ['Anwendungshandbuch', technical],
    ['Benutzerhandbuch', user],
  ]) {
    await db.query(
      `INSERT INTO docs (project_slug, kind, title, content, created_at, updated_at) VALUES ($1, 'manual', $2, $3, $4, $5)`,
      [DEMO_SLUG, title, content, new Date(sprintStart(1) + 10 * DAY), new Date(now - 2 * DAY)],
    );
  }
  for (const [title, content] of [
    [
      'README.md',
      '# Velowerk\n\nWerkstatt- und Buchungsplattform.\n\n## Start\n\n```bash\ndocker compose up\n```\n\n## Tests\n\n```bash\nnpm test\nnpm run test:e2e\n```',
    ],
    [
      'docs/architektur.md',
      '# Architektur\n\n- `frontend/` Angular-App für Schalter, Werkstatt und Portal\n- `backend/` NestJS-API, Module je Fachbereich\n- `infra/` Docker, Backups, Monitoring',
    ],
  ]) {
    await db.query(
      `INSERT INTO docs (project_slug, kind, title, content, created_at, updated_at) VALUES ($1, 'repo', $2, $3, $4, $4)`,
      [DEMO_SLUG, title, content, new Date(now - 5 * DAY)],
    );
  }
}

async function writeTestRuns(
  db: PoolClient,
  orders: Order[],
  sprintStart: (no: number) => number,
  now: number,
): Promise<void> {
  for (let no = 1; no <= ACTIVE; no++) {
    if (no === CANCELLED) continue;
    const unit = 40 + no * 19;
    const e2e = 4 + no * 2;
    const runs: { at: number; status: 'passed' | 'failed'; branch: string; trigger: string }[] = [];
    if (no < ACTIVE) {
      const at = sprintStart(no) + 11 * DAY + 14 * HOUR;
      if (no % 4 === 2)
        runs.push({ at: at - 3 * HOUR, status: 'failed', branch: `sprint/sprint-${no}`, trigger: 'full' });
      runs.push({ at, status: 'passed', branch: `sprint/sprint-${no}`, trigger: 'full' });
    } else {
      runs.push({ at: now - 2 * DAY, status: 'passed', branch: `sprint/sprint-${no}`, trigger: 'manual' });
      runs.push({ at: now - 5 * HOUR, status: 'failed', branch: `sprint/sprint-${no}`, trigger: 'manual' });
    }
    for (const run of runs) {
      const id = randomUUID();
      const failed = run.status === 'failed';
      const durations = [int(20, 40), int(15, 30), int(60, 140), int(180, 420)].map((seconds) => seconds * 1000);
      const end = run.at + durations.reduce((sum, value) => sum + value, 0);
      await db.query(
        `INSERT INTO test_runs (id, project_slug, status, trigger, branch, commit_sha, started_at, completed_at, platform, report)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'linux', $9)`,
        [
          id,
          DEMO_SLUG,
          run.status,
          run.trigger,
          run.branch,
          hex(40),
          new Date(run.at),
          new Date(end),
          `# Testlauf ${run.branch}\n\n- Unit: ${failed ? unit - 2 : unit} von ${unit} bestanden\n- E2E: ${e2e} von ${e2e} bestanden`,
        ],
      );
      const steps: [string, string, string][] = [
        [
          'npm run typecheck',
          'quality',
          '> velowerk@1.0.0 typecheck\n> tsc --noEmit -p backend && tsc --noEmit -p frontend',
        ],
        ['npm run lint', 'quality', '✔ Keine Probleme gefunden'],
        [
          'npm test',
          'unit',
          failed
            ? `✗ 2 von ${unit} fehlgeschlagen\n  ✗ reviews-trend.spec.ts › gruppiert nach Monat\n  ✗ reviews-trend.spec.ts › füllt leere Monate`
            : `✓ ${unit} Tests bestanden`,
        ],
        ['npm run test:e2e', 'e2e', `✓ ${e2e} Tests bestanden (Chromium, Mobile Safari)`],
      ];
      for (const [position, [command, category, output]] of steps.entries()) {
        await db.query(
          `INSERT INTO test_run_steps (run_id, position, command, status, exit_code, duration_ms, output, category, started_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            id,
            position,
            command,
            failed && position === 2 ? 'failed' : 'passed',
            failed && position === 2 ? 1 : 0,
            durations[position],
            output,
            category,
            new Date(run.at),
          ],
        );
      }
      if (no >= ACTIVE - 1) {
        const titles = orders
          .filter((order) => order.sprintNo === no && order.kind !== 'bug')
          .map((order) => order.title);
        for (const [position, title] of titles.slice(0, 8).entries()) {
          await db.query(
            `INSERT INTO test_cases (run_id, position, category, title, file, device, status, duration_ms)
             VALUES ($1, $2, 'e2e', $3, $4, $5, 'passed', $6)`,
            [
              id,
              position,
              title,
              `e2e/${slugify(title)}.spec.ts`,
              position % 2 ? 'Mobile Safari' : 'Chromium',
              int(1200, 9000),
            ],
          );
        }
      }
    }
    if (no < ACTIVE) {
      const report = randomUUID();
      await db.query(
        `INSERT INTO test_coverage_reports (id, project_slug, summary, created_at) VALUES ($1, $2, $3, $4)`,
        [report, DEMO_SLUG, `Abdeckung nach Sprint ${no}`, new Date(sprintStart(no) + 11 * DAY + 15 * HOUR)],
      );
      for (const [area, base, slope] of [
        ['backend', 55, 1.25],
        ['frontend', 46, 1.4],
      ] as const) {
        const lines = Math.min(89, base + no * slope + between(-1.5, 1.5));
        await db.query(
          `INSERT INTO test_coverage_areas (report_id, area, unit_tests, component_tests, integration_tests, e2e_tests, passed, failed,
             lines, statements, branches, functions)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $8, $9, $10, $11)`,
          [
            report,
            area,
            Math.round(unit * (area === 'backend' ? 0.6 : 0.4)),
            area === 'frontend' ? Math.round(unit * 0.2) : 0,
            area === 'backend' ? 12 + no : 0,
            area === 'frontend' ? e2e : 0,
            Math.round(unit / 2) + e2e,
            lines,
            lines - 1.2,
            lines - 9,
            lines + 2,
          ],
        );
      }
    }
  }
}

async function writeProduction(
  db: PoolClient,
  orders: Order[],
  sprintStart: (no: number) => number,
  calendarBug: string,
  now: number,
): Promise<void> {
  for (let no = 1; no < ACTIVE; no++) {
    if (no === CANCELLED) continue;
    const ids = orders.filter((order) => order.sprintNo === no && order.status === 'done').map((order) => order.id);
    await db.query(`INSERT INTO production_deploys (project_slug, deployed_at, order_ids) VALUES ($1, $2, $3)`, [
      DEMO_SLUG,
      new Date(sprintStart(no + 1) + 5.5 * HOUR),
      ids,
    ]);
  }
  const events: [string, string, string, string, number, number, string | null][] = [
    [
      'calendar-typeerror',
      'ingest',
      'frontend',
      "TypeError: Cannot read properties of undefined (reading 'opensAt')\n    at BookingCalendarComponent.slotsFor (booking-calendar.component.ts:142)",
      37,
      2,
      calendarBug,
    ],
    ['sms-gateway-timeout', 'logs', 'backend', 'SmsGatewayError: connect ETIMEDOUT smsgw.swisscom.ch:443', 6, 1, null],
    ['health-slow', 'health', 'health', 'GET /api/health antwortete in 2.3 s (Schwelle 2 s)', 2, 0.5, null],
  ];
  for (const [fingerprint, source, origin, sample, count, days, bugId] of events) {
    const id = randomUUID();
    await db.query(
      `INSERT INTO production_events (id, project_slug, fingerprint, source, origin, first_seen, last_seen, count, sample, bug_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        id,
        DEMO_SLUG,
        fingerprint,
        source,
        origin,
        new Date(now - days * DAY),
        new Date(now - int(5, 50) * MIN),
        count,
        sample,
        bugId,
      ],
    );
    let left = count;
    for (let hour = Math.ceil(days * 24); hour >= 0 && left > 0; hour--) {
      if (rng() < 0.6) continue;
      const value = Math.min(left, int(1, 4));
      left -= value;
      const bucket = Math.floor((now - hour * HOUR) / HOUR) * HOUR;
      await db.query(
        `INSERT INTO production_event_buckets (event_id, hour, count) VALUES ($1, $2, $3) ON CONFLICT (event_id, hour) DO UPDATE SET count = production_event_buckets.count + EXCLUDED.count`,
        [id, new Date(bucket), value],
      );
    }
  }
  await db.query(
    `INSERT INTO production_status (project_slug, failures, down, checked_at, logs_scanned_at) VALUES ($1, 0, FALSE, $2, $3)`,
    [DEMO_SLUG, new Date(now - MIN), new Date(now - 4 * MIN)],
  );
}

async function writeChat(db: PoolClient, orders: Order[], now: number): Promise<void> {
  const express = orders.find((order) => order.kind === 'express' && order.sprintNo === ACTIVE);
  const messages: [string, string, number, string | null][] = [
    ['user', 'Wie viele Aufträge hat der aktuelle Sprint noch offen, und was blockiert?', 3 * DAY, null],
    [
      'assistant',
      'Im **Sprint 24 · Herbst-Release** sind 5 von 11 Aufträgen erledigt.\n\n- 1 wartet auf deine Freigabe: „Abholplan als Tagesliste für den Schalter“\n- 1 läuft gerade: „Velo-Standort im Lager per Regalplatz“\n- 1 ist blockiert: „Bewertungen im Dashboard der Filialleitung“ – der Tester vermisst den Monatstrend\n- 3 sind noch geplant',
      3 * DAY - 40_000,
      null,
    ],
  ];
  if (express) {
    messages.push([
      'user',
      `Express: ${express.context.replace(/\.$/, '')} – ${express.title}.`,
      now - express.createdAt.getTime(),
      express.id,
    ]);
    messages.push([
      'assistant',
      `Als Express-Anfrage aufgenommen: „${express.title}“. Sie läuft im aktuellen Sprint mit.`,
      now - express.createdAt.getTime() - 30_000,
      express.id,
    ]);
  }
  messages.push(
    ['user', 'Fasse den Stand des Herbst-Release in drei Sätzen für die Filialleitung zusammen.', 70 * MIN, null],
    [
      'assistant',
      'Kundinnen und Kunden wählen ab sofort per SMS-Link ein Abholfenster, die Überbuchung bei gleichzeitiger Wahl ist behoben. Nach der Abholung können sie die Filiale mit 1 bis 5 Sternen bewerten. Diese Woche folgen der Abholplan für den Schalter und der Regalplatz für fertige Velos.',
      69 * MIN,
      null,
    ],
  );
  for (const [role, content, ago, developmentId] of messages) {
    await db.query(
      `INSERT INTO chat_messages (project_slug, role, content, status, development_id, created_at, updated_at) VALUES ($1, $2, $3, 'done', $4, $5, $5)`,
      [DEMO_SLUG, role, content, developmentId, new Date(now - ago)],
    );
  }
}

async function writeGitGraph(
  db: PoolClient,
  orders: Order[],
  sprintStart: (no: number) => number,
  now: number,
): Promise<void> {
  interface Commit {
    hash: string;
    parents: string[];
    author: string;
    date: string;
    subject: string;
    refs: string[];
    pushed: boolean;
  }
  const commits: Commit[] = [];
  let main = hex(40);
  commits.push({
    hash: main,
    parents: [],
    author: 'Marco Keller',
    date: new Date(sprintStart(1)).toISOString(),
    subject: 'Initial commit',
    refs: [],
    pushed: true,
  });
  for (let no = 1; no <= ACTIVE; no++) {
    if (no === CANCELLED) continue;
    let tip = main;
    const done = orders
      .filter(
        (order) =>
          order.sprintNo === no && order.status === 'done' && order.completedAt && order.completedAt.getTime() < now,
      )
      .sort((a, b) => a.completedAt!.getTime() - b.completedAt!.getTime());
    const area = DEMO_SPRINTS[no - 1]!.area;
    for (const order of done) {
      const prefix = order.kind === 'bug' ? 'fix' : order.category === 'docs' ? 'docs' : 'feat';
      const commit: Commit = {
        hash: order.commit ?? hex(40),
        parents: [tip],
        author: 'AIdeation Agent',
        date: order.completedAt!.toISOString(),
        subject: `${prefix}(${area}): ${order.title}`,
        refs: [],
        pushed: true,
      };
      commits.push(commit);
      tip = commit.hash;
    }
    if (no < ACTIVE) {
      const last = done.at(-1)?.completedAt?.getTime() ?? 0;
      const merge: Commit = {
        hash: hex(40),
        parents: [main, tip],
        author: 'AIdeation Agent',
        date: new Date(Math.max(sprintStart(no + 1) + 5 * HOUR, last + 30 * MIN)).toISOString(),
        subject: `Merge sprint/sprint-${no}: ${DEMO_SPRINTS[no - 1]!.name}`,
        refs: [],
        pushed: true,
      };
      commits.push(merge);
      main = merge.hash;
    } else {
      commits.at(-1)!.refs = ['HEAD -> sprint/sprint-24', 'origin/sprint/sprint-24'];
    }
  }
  const mainCommit = commits.find((commit) => commit.hash === main);
  if (mainCommit) mainCommit.refs = ['origin/main', 'main', `tag: v1.${ACTIVE - 1}.0`];
  const newest = commits.sort((a, b) => b.date.localeCompare(a.date)).slice(0, 80);
  await db.query(`INSERT INTO project_git_graphs (project_slug, graph, updated_at) VALUES ($1, $2, $3)`, [
    DEMO_SLUG,
    JSON.stringify({ webUrl: 'https://github.com/velowerk/werkstatt', head: 'sprint/sprint-24', commits: newest }),
    new Date(now - 2 * MIN),
  ]);
}
