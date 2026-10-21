import type { Pool } from 'pg';
import { isUntrustedBugSource, unapprovedBugSql } from '../core/bug-trust.js';

/**
 * Testhilfe (keine eigenen Tests): Speicher für die Tabellen des Produktions-Rückkanals, der genau die Anweisungen
 * von production-events, production-monitor, deploy und ingest beantwortet. So laufen die Abläufe ohne Datenbank.
 */
export interface FakeProject {
  slug: string;
  name: string;
  autoBugfix: boolean;
  healthUrl: string | null;
  logServices: string[];
  ignore: string[];
  tokenHash: string | null;
  deployCommands: string[][] | null;
  deployStatus?: string;
}
export interface FakeEvent {
  id: string;
  project: string;
  fingerprint: string;
  source: string;
  origin: string;
  count: number;
  sample: string;
  firstSeen: Date;
  lastSeen: Date;
  bugId: string | null;
  deploySuspect: unknown;
}
export interface FakeBug {
  id: string;
  project: string;
  title: string;
  description: string;
  severity: string;
  status: string;
  source: string;
  category: string | null;
  fixNotes: string;
  regressedAt: Date | null;
  /** Freigabe durch einen Menschen (fremde Quellen). */
  approvedAt?: Date | null;
}
export interface FakeOrder {
  id: string;
  project: string;
  title: string;
  status: string;
  bugId: string | null;
  autoRun: boolean;
  description?: string;
  sprintId?: string | null;
  completedAt?: Date | null;
}
export interface FakeStatus {
  failures: number;
  down: boolean;
  lastError: string | null;
  problems: string[];
  notifiedAt: Date | null;
  logsScannedAt: Date | null;
  logError: string | null;
}

export class FakeProductionDb {
  readonly projects = new Map<string, FakeProject>();
  readonly events: FakeEvent[] = [];
  readonly buckets = new Map<string, number>();
  readonly bugs: FakeBug[] = [];
  readonly orders: FakeOrder[] = [];
  readonly deploys: { project: string; deployedAt: Date; orderIds: string[] }[] = [];
  readonly sprints = new Map<string, string>();
  readonly status = new Map<string, FakeStatus>();
  readonly statements: string[] = [];
  private nextId = 1;

  constructor(project: Partial<FakeProject> = {}) {
    this.addProject(project);
  }

  addProject(project: Partial<FakeProject> = {}): FakeProject {
    const full: FakeProject = {
      slug: 'shop',
      name: 'Shop',
      autoBugfix: false,
      healthUrl: null,
      logServices: [],
      ignore: [],
      tokenHash: null,
      deployCommands: null,
      ...project,
    };
    this.projects.set(full.slug, full);
    return full;
  }

  private id(): string {
    return `00000000-0000-4000-8000-${String(this.nextId++).padStart(12, '0')}`;
  }

  private state(project: string): FakeStatus {
    let state = this.status.get(project);
    if (!state) {
      state = {
        failures: 0,
        down: false,
        lastError: null,
        problems: [],
        notifiedAt: null,
        logsScannedAt: null,
        logError: null,
      };
      this.status.set(project, state);
    }
    return state;
  }

  bucketHour(at: Date): number {
    const hour = new Date(at);
    hour.setUTCMinutes(0, 0, 0);
    return hour.getTime();
  }

  get pool(): Pool {
    const query = async (sql: string, values: unknown[] = []) => this.query(sql, values);
    return { query, connect: async () => ({ query, release: () => undefined }) } as unknown as Pool;
  }

  query(sql: string, v: unknown[]): { rows: Record<string, unknown>[]; rowCount: number } {
    const text = sql.replace(/\s+/g, ' ').trim();
    this.statements.push(text);
    const rows = (list: Record<string, unknown>[]) => ({ rows: list, rowCount: list.length });
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(text)) return rows([]);

    if (text.startsWith('INSERT INTO production_events')) {
      const [project, fingerprint, source, origin, count, sample, at] = v as [
        string,
        string,
        string,
        string,
        number,
        string,
        Date,
      ];
      let event = this.events.find((entry) => entry.project === project && entry.fingerprint === fingerprint);
      if (event) Object.assign(event, { count: event.count + count, lastSeen: at, sample, origin });
      else {
        event = {
          id: this.id(),
          project,
          fingerprint,
          source,
          origin,
          count,
          sample,
          firstSeen: at,
          lastSeen: at,
          bugId: null,
          deploySuspect: null,
        };
        this.events.push(event);
      }
      return rows([{ id: event.id, bugId: event.bugId }]);
    }
    if (text.startsWith('INSERT INTO production_event_buckets')) {
      const [eventId, at, count] = v as [string, Date, number];
      const key = `${eventId}|${this.bucketHour(at)}`;
      this.buckets.set(key, (this.buckets.get(key) ?? 0) + count);
      return rows([{ count: this.buckets.get(key) }]);
    }
    if (text.startsWith('SELECT SUM(count) AS total FROM production_event_buckets')) {
      const [eventId, at, windowMs] = v as [string, Date, number];
      const from = this.bucketHour(new Date(at.getTime() - windowMs));
      let total = 0;
      for (const [key, count] of this.buckets) {
        const [id, hour] = key.split('|');
        if (id === eventId && Number(hour) >= from) total += count;
      }
      return rows([{ total: total ? String(total) : null }]);
    }
    if (text.startsWith('SELECT status, severity FROM bugs WHERE id = $1')) {
      const bug = this.bugs.find((entry) => entry.id === v[0]);
      return rows(bug ? [{ status: bug.status, severity: bug.severity }] : []);
    }
    if (text.startsWith('INSERT INTO bugs')) {
      const [project, title, description, severity, category] = v as string[];
      const bug: FakeBug = {
        id: this.id(),
        project: project!,
        title: title!,
        description: description!,
        severity: severity!,
        status: 'open',
        source: 'production',
        category: category ?? null,
        fixNotes: '',
        regressedAt: null,
      };
      this.bugs.push(bug);
      return rows([{ id: bug.id }]);
    }
    if (text.startsWith('UPDATE production_events SET bug_id = $2, deploy_suspect = $3')) {
      const event = this.events.find((entry) => entry.id === v[0])!;
      event.bugId = v[1] as string;
      event.deploySuspect = JSON.parse(v[2] as string);
      return rows([]);
    }
    if (text.startsWith('UPDATE production_events SET deploy_suspect = $2')) {
      this.events.find((entry) => entry.id === v[0])!.deploySuspect = JSON.parse(v[1] as string);
      return rows([]);
    }
    if (text.startsWith("UPDATE bugs SET status = 'open', fixed_at = NULL, regressed_at")) {
      const bug = this.bugs.find((entry) => entry.id === v[0])!;
      Object.assign(bug, {
        status: 'open',
        regressedAt: v[1],
        severity: v[2],
        fixNotes: bug.fixNotes ? `${bug.fixNotes}\n\n${v[3]}` : v[3],
        ...(text.includes('approved_at = NULL') ? { approvedAt: null } : {}),
      });
      return rows([]);
    }
    if (text.startsWith('UPDATE bugs SET severity = $2')) {
      this.bugs.find((entry) => entry.id === v[0])!.severity = v[1] as string;
      return rows([]);
    }
    if (text.startsWith('SELECT deployed_at AS "deployedAt", order_ids AS "orderIds" FROM production_deploys')) {
      const at = v[1] as Date;
      const latest = this.deploys
        .filter((deploy) => deploy.project === v[0] && deploy.deployedAt <= at)
        .sort((a, b) => b.deployedAt.getTime() - a.deployedAt.getTime())[0];
      return rows(latest ? [{ deployedAt: latest.deployedAt, orderIds: latest.orderIds }] : []);
    }
    if (text.startsWith('SELECT d.id, d.title, d.sprint_id AS "sprintId"')) {
      const ids = v[0] as string[];
      return rows(
        this.orders
          .filter((order) => ids.includes(order.id))
          .map((order) => ({
            id: order.id,
            title: order.title,
            sprintId: order.sprintId ?? null,
            sprintName: order.sprintId ? (this.sprints.get(order.sprintId) ?? null) : null,
          })),
      );
    }
    if (text.startsWith('INSERT INTO production_deploys')) {
      const project = v[0] as string;
      const previous = this.deploys
        .filter((deploy) => deploy.project === project)
        .reduce((max, deploy) => Math.max(max, deploy.deployedAt.getTime()), Date.now() - 86_400_000);
      const orderIds = this.orders
        .filter(
          (order) =>
            order.project === project &&
            order.status === 'done' &&
            order.completedAt &&
            order.completedAt.getTime() > previous,
        )
        .map((order) => order.id);
      this.deploys.push({ project, deployedAt: new Date(), orderIds });
      return rows([]);
    }
    if (text.startsWith('SELECT auto_bugfix AS auto FROM projects')) {
      const project = this.projects.get(v[0] as string);
      return rows(project ? [{ auto: project.autoBugfix }] : []);
    }
    if (text.startsWith("UPDATE development_items SET status = 'planned', auto_run = TRUE")) {
      const done = this.orders.filter((order) => order.bugId === v[0] && order.status === 'done');
      for (const order of done) Object.assign(order, { status: 'planned', autoRun: true });
      return { rows: [], rowCount: done.length };
    }
    if (text.startsWith('INSERT INTO development_items')) {
      const bug = this.bugs.find((entry) => entry.id === v[0])!;
      if (this.orders.some((order) => order.bugId === bug.id)) return rows([]);
      // Wie die Bedingung in queueBugFix: fremde, nicht freigegebene Bugs bekommen keinen Auftrag.
      const gated = text.includes(unapprovedBugSql('b'));
      if (gated && isUntrustedBugSource(bug.source) && !bug.approvedAt) return { rows: [], rowCount: 0 };
      this.orders.push({
        id: this.id(),
        project: bug.project,
        title: `Bug: ${bug.title}`,
        status: 'planned',
        bugId: bug.id,
        autoRun: true,
        description: `${(v[3] as string | null) ?? 'Behebe den Fehler …'}\n\n${bug.description}`,
      });
      return { rows: [], rowCount: 1 };
    }
    if (text.startsWith('SELECT p.health_url AS url, s.failures, s.down')) {
      const project = this.projects.get(v[0] as string);
      const state = this.status.get(v[0] as string);
      return rows(
        project ? [{ url: project.healthUrl, failures: state?.failures ?? null, down: state?.down ?? null }] : [],
      );
    }
    if (text.startsWith('INSERT INTO production_status (project_slug, failures, down')) {
      Object.assign(this.state(v[0] as string), { failures: v[1], down: v[2], lastError: v[3] });
      return rows([]);
    }
    if (text.startsWith('UPDATE production_status SET failures = 0')) {
      Object.assign(this.state(v[0] as string), { failures: 0, down: false });
      return rows([]);
    }
    if (text.startsWith('SELECT s.down, p.health_url AS url')) {
      const project = this.projects.get(v[0] as string);
      return rows(project ? [{ down: this.status.get(project.slug)?.down ?? null, url: project.healthUrl }] : []);
    }
    if (text.startsWith('SELECT b.title FROM bugs b')) {
      const hourAgo = Date.now() - 3600_000;
      return rows(
        this.bugs
          .filter(
            (bug) =>
              bug.project === v[0] &&
              bug.source === 'production' &&
              bug.severity === 'critical' &&
              ['open', 'in_progress'].includes(bug.status) &&
              this.events.some(
                (event) => event.bugId === bug.id && event.source !== 'health' && event.lastSeen.getTime() > hourAgo,
              ),
          )
          .map((bug) => ({ title: bug.title })),
      );
    }
    if (text.startsWith('SELECT p.name, s.problems, s.notified_at')) {
      const project = this.projects.get(v[0] as string);
      const state = this.status.get(v[0] as string);
      return rows(
        project
          ? [{ name: project.name, problems: state?.problems ?? null, notifiedAt: state?.notifiedAt ?? null }]
          : [],
      );
    }
    if (text.startsWith('INSERT INTO production_status (project_slug, problems, notified_at)')) {
      Object.assign(this.state(v[0] as string), { problems: v[1], notifiedAt: v[2] });
      return rows([]);
    }
    if (text.startsWith('SELECT p.log_services AS services')) {
      const project = this.projects.get(v[0] as string);
      return rows(
        project
          ? [
              {
                services: project.logServices,
                ignore: project.ignore,
                scannedAt: this.status.get(project.slug)?.logsScannedAt ?? null,
              },
            ]
          : [],
      );
    }
    if (text.startsWith('INSERT INTO production_status (project_slug, logs_scanned_at, log_error)')) {
      const state = this.state(v[0] as string);
      state.logError = v[2] as string | null;
      if (!state.logError) state.logsScannedAt = v[1] as Date;
      return rows([]);
    }
    if (text.startsWith('SELECT deploy_commands AS commands FROM projects')) {
      return rows([{ commands: this.projects.get(v[0] as string)?.deployCommands ?? null }]);
    }
    if (text.startsWith('UPDATE projects SET deploy_status')) {
      this.projects.get(v[0] as string)!.deployStatus = v[1] as string;
      return rows([]);
    }
    if (text.startsWith('SELECT ingest_token_hash AS hash, production_ignore AS ignore FROM projects')) {
      const project = this.projects.get(v[0] as string);
      return rows(project ? [{ hash: project.tokenHash, ignore: project.ignore }] : []);
    }
    if (text.startsWith('UPDATE projects SET ingest_token_hash = $2')) {
      const project = this.projects.get(v[0] as string);
      if (project) project.tokenHash = v[1] as string;
      return { rows: [], rowCount: project ? 1 : 0 };
    }
    // Alles andere (Push-Geräte, Sitzungen …): leer.
    return rows([]);
  }
}
