import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import express from 'express';
import type { Pool } from 'pg';
import { withMigratedDatabase } from '../db/test-database.test.js';
import { access, routeTable, type RouteEntry } from './access.js';
import { createApiRouter } from './app.js';
import type { Principal } from './roles.js';
import { apiRoutes } from './route-table.test.js';
import { type RouteClient, serveRoutes } from './serve-routes.test.js';
import { TENANT_ID_EXEMPT, TENANT_ID_FIELDS } from './tenant-id-fields.js';

/**
 * Mandanten-Prüfung aller ID-Felder (Vorfall: docs/agent-handoff-nur-eigenes-projekt-2026-10-25.md).
 *
 * 1. Vollständigkeit ohne Datenbank: Die registrierten Express-Routen und ihr Quelltext ergeben alle ID-Felder (weitere
 *    Pfadparameter neben dem Mandanten, Body-Felder wie agentId, sprintId, handoffTo, ids). Jedes muss in der Allowlist
 *    (tenant-id-fields.ts) stehen.
 * 2. Verhalten auf PostgreSQL: Zwei Projekte wie in der Attrappe von agents.test.ts („demo“ und „fremd“). Je Eintrag
 *    eine gültige ID aus „fremd“ → 400/404 und die Datenbank bleibt unverändert; eine ID aus „demo“ → bisheriger Status.
 */

interface Source {
  file: string;
  text: string;
}

export interface FoundIdField {
  method: string;
  path: string;
  in: 'path' | 'body';
  field: string;
}

/** Feldnamen, die eine ID tragen: agentId, sprintId, ids, handoffTo, replyTo, references … */
const ID_NAME = /^(?:ids|\w+Ids?|\w+To|references)$/;
/** Lesen aus dem Body: body.x, record.x, request.body.x, (request.body as …)?.x */
const BODY_READ = /(?:\bbody|\brecord|\))\??\.(\w+)/g;
/** Feldlisten für parseFields/invalidInput: name: { column: '…', parse: parseUuid | parseNullableUuid } */
const FIELD_DEF = /(\w+): \{ column: '\w+', parse: parse(?:Nullable)?Uuid \}/g;
/** Oberste Deklarationen; Hilfen wie parseTask oder DEV_FIELDS, die eine Route über ihren Namen nutzt. */
const DECLARATION = /^(?:export )?(?:async )?(?:function|const|let|interface|type|class) (\w+)/gm;
const REGISTRATION = /\.(?:get|post|put|patch|delete)\(\s*'\//g;

function idNames(text: string): Set<string> {
  const names = new Set<string>();
  for (const pattern of [BODY_READ, FIELD_DEF]) {
    for (const match of text.matchAll(pattern)) if (ID_NAME.test(match[1]!)) names.add(match[1]!);
  }
  return names;
}

const mentions = (text: string, name: string): boolean => new RegExp(`\\b${name}\\b`).test(text);

/** Hilfen mit ID-Feldern, auch über weitere Hilfen (NEW_ORDER_FIELDS → DEV_FIELDS); ohne register*-Funktionen. */
function idHelpers(sources: Source[]): Map<string, Set<string>> {
  const helpers: { name: string; text: string; fields: Set<string> }[] = [];
  for (const { text } of sources) {
    const starts = [...text.matchAll(DECLARATION)];
    starts.forEach((match, index) => {
      if (match[1]!.startsWith('register')) return;
      const chunk = text.slice(match.index, starts[index + 1]?.index ?? text.length);
      helpers.push({ name: match[1]!, text: chunk, fields: idNames(chunk) });
    });
  }
  for (let changed = true; changed; ) {
    changed = false;
    const withIds = helpers.filter((helper) => helper.fields.size);
    for (const helper of helpers) {
      for (const used of withIds) {
        if (used === helper || !mentions(helper.text, used.name)) continue;
        for (const field of used.fields) {
          if (!helper.fields.has(field)) changed = !!helper.fields.add(field);
        }
      }
    }
  }
  const result = new Map<string, Set<string>>();
  for (const helper of helpers.filter((entry) => entry.fields.size)) {
    result.set(helper.name, new Set([...(result.get(helper.name) ?? []), ...helper.fields]));
  }
  return result;
}

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Treffer in Kommentaren zählen nicht (z. B. das Beispiel in access.ts). */
function firstInCode(text: string, pattern: RegExp): number | undefined {
  for (const match of text.matchAll(pattern)) {
    const line = text.slice(text.lastIndexOf('\n', match.index) + 1, match.index);
    if (!/^\s*(?:\*|\/\/|\/\*)/.test(line)) return match.index;
  }
  return undefined;
}

/**
 * Quelltext der Route: von ihrer Registrierung bis zur nächsten Route bzw. Deklaration. Routen mit Pfad aus einer Liste
 * (attachments.ts: app.post(owner.path, …)) ab dem Pfad in der Liste; `fromLists` sind solche Pfade aller Routen.
 */
function routeSource(sources: Source[], method: string, path: string, fromLists: string[]): string | undefined {
  const quoted = `'${path}'`;
  const registration = new RegExp(`\\.${method.toLowerCase()}\\(\\s*${escape(quoted)}`, 'g');
  for (const pass of ['registration', 'literal'] as const) {
    for (const { text } of sources) {
      const start = firstInCode(text, pass === 'registration' ? registration : new RegExp(escape(quoted), 'g'));
      if (start === undefined) continue;
      const boundaries = [
        ...[...text.matchAll(REGISTRATION), ...text.matchAll(DECLARATION)].map((match) => match.index ?? -1),
        ...fromLists.map((other) => text.indexOf(`'${other}'`)),
      ].filter((index) => index > start);
      return text.slice(start, Math.min(text.length, ...boundaries));
    }
  }
  return undefined;
}

/** Pfade registrierter Routen, die nirgends als `.methode('pfad'` stehen (Pfad aus einer Liste). */
function listedPaths(routes: RouteEntry[], sources: Source[]): string[] {
  return [
    ...new Set(
      routes
        .filter((route) => {
          const pattern = new RegExp(`\\.${route.method.toLowerCase()}\\(\\s*${escape(`'${route.path}'`)}`, 'g');
          return sources.every(({ text }) => firstInCode(text, pattern) === undefined);
        })
        .map((route) => route.path),
    ),
  ];
}

/** Alle ID-Felder der Routen; tenant 'admin' (nur Administration, kein Projekt) zählt nicht. */
export function findIdFields(
  routes: RouteEntry[],
  sources: Source[],
): { fields: FoundIdField[]; unlocated: string[] } {
  const helpers = idHelpers(sources);
  const fromLists = listedPaths(routes, sources);
  const fields = new Map<string, FoundIdField>();
  const unlocated: string[] = [];
  const add = (entry: FoundIdField) => fields.set(`${entry.method} ${entry.path} ${entry.field}`, entry);
  for (const route of routes) {
    const tenant = route.access?.tenant ?? 'admin';
    if (tenant === 'admin') continue;
    const own = tenant === 'project' ? 'slug' : tenant === 'global' ? null : 'id';
    for (const [, param] of route.path.matchAll(/:(\w+)/g)) {
      if (param !== own) add({ method: route.method, path: route.path, in: 'path', field: param! });
    }
    const text = routeSource(sources, route.method, route.path, fromLists);
    if (text === undefined) {
      unlocated.push(`${route.method} ${route.path}`);
      continue;
    }
    const names = idNames(text);
    for (const [helper, helperFields] of helpers) {
      if (mentions(text, helper)) for (const field of helperFields) names.add(field);
    }
    for (const field of names) add({ method: route.method, path: route.path, in: 'body', field });
  }
  return { fields: [...fields.values()], unlocated };
}

function apiSources(): Source[] {
  const directory = import.meta.dirname;
  return readdirSync(directory)
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
    .sort()
    .map((file) => ({ file, text: readFileSync(join(directory, file), 'utf8') }));
}

const key = (entry: { method: string; path: string; field: string }) => `${entry.method} ${entry.path} ${entry.field}`;
const listed = new Set([...TENANT_ID_FIELDS, ...TENANT_ID_EXEMPT].map(key));

test('Jede registrierte Route mit ID-Feld steht in der Allowlist', () => {
  const { fields, unlocated } = findIdFields(apiRoutes(), apiSources());
  assert.deepEqual(unlocated, [], 'Routen ohne auffindbaren Quelltext (Registrierung mit festem Pfad nötig)');
  const missing = fields.filter((field) => !listed.has(key(field))).map((field) => `${key(field)} (${field.in})`);
  assert.deepEqual(missing, [], 'In tenant-id-fields.ts eintragen und in der Route assertInProject nutzen');
});

test('Allowlist: jeder Eintrag ist eine registrierte Route mit diesem ID-Feld', () => {
  const found = new Map(findIdFields(apiRoutes(), apiSources()).fields.map((field) => [key(field), field]));
  for (const entry of TENANT_ID_FIELDS) {
    assert.equal(found.get(key(entry))?.in, entry.in, `${key(entry)}: nicht (mehr) als ${entry.in}-Feld gefunden`);
    assert.ok([400, 404].includes(entry.refused), key(entry));
  }
  for (const entry of TENANT_ID_EXEMPT) assert.ok(found.has(key(entry)), `${key(entry)}: Ausnahme veraltet`);
  assert.equal(new Set(TENANT_ID_FIELDS.map(key)).size, TENANT_ID_FIELDS.length, 'doppelte Einträge');
});

test('Gegenprobe Erkennung: eine neue Route mit ID-Feld ohne Eintrag lässt den Test scheitern', () => {
  const router = express.Router();
  const ok = () => undefined;
  router.post('/projects/:slug/extra/:otherId', access({ role: 'plan', tenant: 'project' }), ok);
  router.patch('/extra/:id', access({ role: 'plan', tenant: 'development' }), ok);
  router.post('/projects/:slug/extra-assign', access({ role: 'plan', tenant: 'project' }), ok);
  const source = [
    "  app.post('/projects/:slug/extra/:otherId', access({ role: 'plan', tenant: 'project' }), ok);",
    "  app.patch('/extra/:id', access({ role: 'plan', tenant: 'development' }), async (request) => {",
    '    await parseFields(request.body, EXTRA_FIELDS);',
    '  });',
    "  app.post('/projects/:slug/extra-assign', access({ role: 'plan', tenant: 'project' }), async (request) => {",
    '    const body = request.body as Record<string, unknown>;',
    '    await save(body.sprintId);',
    '  });',
    "const EXTRA_FIELDS = { agentId: { column: 'agent_id', parse: parseNullableUuid } };",
  ].join('\n');
  const { fields, unlocated } = findIdFields(routeTable(router), [{ file: 'extra.ts', text: source }]);
  assert.deepEqual(unlocated, []);
  assert.deepEqual(fields.filter((field) => !listed.has(key(field))).map(key).sort(), [
    'PATCH /extra/:id agentId',
    'POST /projects/:slug/extra-assign sprintId',
    'POST /projects/:slug/extra/:otherId otherId',
  ]);
});

const OWN = 'demo';
const FOREIGN = 'fremd';
const admin: Principal = { id: null, username: 'admin', displayName: 'Admin', roles: ['admin'] };

interface Probe {
  method: string;
  path: string;
  body?: unknown;
}

interface Scenario {
  /** Anfrage mit einer gültigen ID aus dem Projekt „fremd“ an eine Route von „demo“. */
  foreign: Probe;
  /** Dieselbe Anfrage mit einer ID aus „demo“ und ihr bisheriger Erfolgsstatus. */
  own: Probe;
  ownStatus: number;
}

/** Stand aller Tabellen: Zeilenzahl und Inhalt (md5), damit auch Nebenwirkungen (Trigger, Folgezeilen) auffallen. */
async function databaseState(pool: Pool): Promise<Record<string, string>> {
  const tables = (
    await pool.query<{ name: string }>(`SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`)
  ).rows;
  const state: Record<string, string> = {};
  for (const { name } of tables) {
    const row = (
      await pool.query<{ count: number; hash: string }>(
        `SELECT count(*)::int AS count, md5(COALESCE(string_agg(t::text, '|' ORDER BY t::text), '')) AS hash
           FROM "${name}" t`,
      )
    ).rows[0]!;
    state[name] = `${row.count} Zeilen, ${row.hash}`;
  }
  return state;
}

/** Fremde ID: Antwort `expected` (400 oder 404) und unveränderte Datenbank. */
async function refusedWithoutWrite(pool: Pool, api: RouteClient, probe: Probe, expected: number): Promise<void> {
  const before = await databaseState(pool);
  const response = await api.call(probe.method, probe.path, probe.body);
  assert.ok([400, 404].includes(response.status), `${probe.method} ${probe.path}: ${response.status} statt 400/404`);
  assert.equal(response.status, expected, `${probe.method} ${probe.path}`);
  assert.deepEqual(await databaseState(pool), before, `${probe.method} ${probe.path}: Datenbank verändert`);
}

test('Mandanten-Prüfung auf PostgreSQL: fremde IDs 400/404 ohne Schreibzugriff, eigene wie bisher', async (t) => {
  await withMigratedDatabase(t, 'devlog_tenant_ids', async (db) => {
    const pool = db as unknown as Pool;
    for (const slug of [OWN, FOREIGN]) {
      await pool.query(`INSERT INTO projects (slug, name, repository) VALUES ($1, $1, '/tmp/' || $1)`, [slug]);
    }
    let counter = 0;
    const next = () => (counter += 1);
    const id = async (sql: string, values: unknown[]): Promise<string> =>
      (await pool.query<{ id: string }>(sql, values)).rows[0]!.id;
    const agent = (slug: string) =>
      id(`INSERT INTO agents (project_slug, name, phase) VALUES ($1, 'Agent', 'while_task') RETURNING id`, [slug]);
    const sprint = (slug: string) =>
      id(`INSERT INTO sprints (project_slug, name) VALUES ($1, $2) RETURNING id`, [slug, `Sprint ${next()}`]);
    const order = (slug: string, status = 'backlog') =>
      id(
        `INSERT INTO development_items (project_slug, title, status, effort_hours) VALUES ($1, 'Auftrag', $2, 1)
         RETURNING id`,
        [slug, status],
      );
    const idea = (slug: string) =>
      id(`INSERT INTO ideation_items (project_slug, title) VALUES ($1, 'Idee') RETURNING id`, [slug]);
    const testRun = (slug: string) =>
      id(
        `INSERT INTO test_runs (id, project_slug, status, trigger) VALUES (gen_random_uuid(), $1, 'passed', 'manual')
         RETURNING id`,
        [slug],
      );
    const bug = (slug: string) => id(`INSERT INTO bugs (project_slug, title) VALUES ($1, 'Bug') RETURNING id`, [slug]);
    const task = (slug: string) =>
      id(`INSERT INTO agent_tasks (project_slug, title, prompt) VALUES ($1, $2, 'Tu was') RETURNING id`, [
        slug,
        `Aufgabe ${next()}`,
      ]);
    const question = (slug: string) =>
      id(
        `INSERT INTO chat_messages (project_slug, role, content, question)
         VALUES ($1, 'assistant', 'Frage', 'Welche Farbe?') RETURNING id`,
        [slug],
      );
    const step = async (slug: string) =>
      id(
        `INSERT INTO workflow_steps (project_slug, phase, position, agent_id) VALUES ($1, 'while_task', 1, $2)
         RETURNING id`,
        [slug, await agent(slug)],
      );
    /** Agent mit laufendem Schritt (sonst meldet cancel „läuft gerade nicht“). */
    const runningAgent = async (slug: string) => {
      const agentId = await agent(slug);
      const run = await id(
        `INSERT INTO agent_runs (project_slug, development_id, status) VALUES ($1, $2, 'running') RETURNING id`,
        [slug, await order(slug, 'in_progress')],
      );
      await pool.query(
        `INSERT INTO agent_run_steps (run_id, position, agent_id, agent_name, phase, status)
         VALUES ($1, 1, $2, 'Agent', 'while_task', 'running')`,
        [run, agentId],
      );
      return agentId;
    };
    const group = async (slug: string) => {
      const groupId = `x-gruppe-${next()}`;
      await pool.query(
        `INSERT INTO project_permission_groups (project_slug, id, label, rules) VALUES ($1, $2, 'Checks', $3)`,
        [slug, groupId, ['Bash(make test)']],
      );
      return groupId;
    };
    const api = await serveRoutes(admin, (router) => router.use(createApiRouter(pool, null)));
    /** Aufträge aus dem aktuellen Vorschlag der Sprintplanung von „demo“ (nur die nimmt die Route an). */
    const proposed = async (): Promise<string[]> => {
      await order(OWN);
      const response = await api.call('GET', `/projects/${OWN}/sprints/proposal`);
      const ids = ((response.body?.proposal?.items ?? []) as { id: string }[]).map((item) => item.id);
      assert.ok(ids.length, 'Sprintplanung schlägt keinen Auftrag vor');
      return ids.slice(0, 1);
    };
    const post = (path: string, body: unknown): Probe => ({ method: 'POST', path, body });
    const patch = (path: string, body: unknown): Probe => ({ method: 'PATCH', path, body });
    const get = (path: string): Probe => ({ method: 'GET', path });
    const same = async (
      probe: (value: string) => Probe,
      make: (slug: string) => Promise<string>,
      ownStatus: number,
    ): Promise<Scenario> => ({ foreign: probe(await make(FOREIGN)), own: probe(await make(OWN)), ownStatus });

    const scenarios: Record<string, () => Promise<Scenario>> = {
      'POST /projects/:slug/agent-tasks agentId': () =>
        same(
          (agentId) => post(`/projects/${OWN}/agent-tasks`, { title: `Aufgabe ${next()}`, prompt: 'x', agentId }),
          agent,
          201,
        ),
      'PATCH /agent-tasks/:id agentId': async () => {
        const taskId = await task(OWN);
        return same((agentId) => patch(`/agent-tasks/${taskId}`, { title: 'Neu', prompt: 'x', agentId }), agent, 200);
      },
      'POST /projects/:slug/agents handoffTo': () =>
        same((handoffTo) => post(`/projects/${OWN}/agents`, { name: 'X', phase: 'while_task', handoffTo }), agent, 201),
      'POST /projects/:slug/agents/order ids': async () => {
        const ownAgent = await agent(OWN);
        const reorder = (ids: string[]) => post(`/projects/${OWN}/agents/order`, { phase: 'while_task', ids });
        // Gemischte Liste: Ohne Prüfung ordnete das UPDATE den eigenen Agent um und antwortete 204.
        return { foreign: reorder([ownAgent, await agent(FOREIGN)]), own: reorder([ownAgent]), ownStatus: 204 };
      },
      'PATCH /agents/:id handoffTo': async () => {
        const agentId = await agent(OWN);
        return same((handoffTo) => patch(`/agents/${agentId}`, { handoffTo }), agent, 200);
      },
      'GET /projects/:slug/agents/:id/activity id': () =>
        same((agentId) => get(`/projects/${OWN}/agents/${agentId}/activity`), agent, 200),
      'POST /projects/:slug/agents/:id/cancel id': () =>
        same((agentId) => post(`/projects/${OWN}/agents/${agentId}/cancel`, {}), runningAgent, 202),
      'POST /projects/:slug/bugs sprintId': () =>
        same((sprintId) => post(`/projects/${OWN}/bugs`, { title: 'Bug', sprintId }), sprint, 201),
      'PATCH /bugs/:id sprintId': async () => {
        const bugId = await bug(OWN);
        return same((sprintId) => patch(`/bugs/${bugId}`, { sprintId }), sprint, 200);
      },
      'POST /projects/:slug/chat agentId': () =>
        same((agentId) => post(`/projects/${OWN}/chat`, { content: 'Hallo', agentId }), agent, 201),
      'POST /projects/:slug/chat replyTo': () =>
        same((replyTo) => post(`/projects/${OWN}/chat`, { content: 'Blau', replyTo }), question, 201),
      'POST /projects/:slug/chat references': () => {
        const refer = (orderId: string) =>
          post(`/projects/${OWN}/chat`, { content: 'Siehe', references: [{ type: 'order', id: orderId }] });
        return same(refer, (slug) => order(slug), 201);
      },
      'POST /projects/:slug/development ideationId': () =>
        same((ideationId) => post(`/projects/${OWN}/development`, { title: 'Neu', ideationId }), idea, 201),
      'POST /projects/:slug/development testRunId': () =>
        same((testRunId) => post(`/projects/${OWN}/development`, { title: 'Neu', testRunId }), testRun, 201),
      'POST /projects/:slug/development sprintId': () =>
        same((sprintId) => post(`/projects/${OWN}/development`, { title: 'Neu', sprintId }), sprint, 201),
      'POST /projects/:slug/development agentId': () =>
        same((agentId) => post(`/projects/${OWN}/development`, { title: 'Neu', agentId }), agent, 201),
      'POST /development/:id/follow-up sprintId': async () => {
        const done = await order(OWN, 'done');
        return same((sprintId) => post(`/development/${done}/follow-up`, { title: 'Nachtrag', sprintId }), sprint, 201);
      },
      'POST /development/:id/retry sprintId': async () => {
        const blocked = await order(OWN, 'blocked');
        return same((sprintId) => post(`/development/${blocked}/retry`, { sprintId }), sprint, 200);
      },
      'POST /development/:id/take-into-sprint sprintId': async () => {
        const open = await order(OWN);
        return same((sprintId) => post(`/development/${open}/take-into-sprint`, { sprintId }), sprint, 200);
      },
      'PATCH /development/:id sprintId': async () => {
        const open = await order(OWN);
        return same((sprintId) => patch(`/development/${open}`, { sprintId }), sprint, 200);
      },
      'PATCH /development/:id agentId': async () => {
        const open = await order(OWN);
        return same((agentId) => patch(`/development/${open}`, { agentId }), agent, 200);
      },
      'GET /projects/:slug/test-runs/:id/cases id': () =>
        same((runId) => get(`/projects/${OWN}/test-runs/${runId}/cases`), testRun, 200),
      'PATCH /projects/:slug/permission-groups/:id id': () => {
        const rename = (groupId: string) =>
          patch(`/projects/${OWN}/permission-groups/${groupId}`, { label: 'Neu', rules: ['Bash(make test)'] });
        return same(rename, group, 200);
      },
      'DELETE /projects/:slug/permission-groups/:id id': () =>
        same((groupId) => ({ method: 'DELETE', path: `/projects/${OWN}/permission-groups/${groupId}` }), group, 204),
      'POST /projects/:slug/review-slots/start developmentId': () =>
        same(
          (developmentId) => post(`/projects/${OWN}/review-slots/start`, { commit: 'a'.repeat(40), developmentId }),
          order,
          200,
        ),
      'POST /projects/:slug/workflow/steps agentId': () =>
        same((agentId) => post(`/projects/${OWN}/workflow/steps`, { phase: 'while_task', agentId }), agent, 201),
      'POST /projects/:slug/workflow/order ids': async () => {
        const ownStep = await step(OWN);
        const reorder = (ids: string[]) => post(`/projects/${OWN}/workflow/order`, { phase: 'while_task', ids });
        return { foreign: reorder([ownStep, await step(FOREIGN)]), own: reorder([ownStep]), ownStatus: 204 };
      },
      'POST /sprints/:id/order ids': async () => {
        const sprintId = await sprint(OWN);
        return same((orderId) => post(`/sprints/${sprintId}/order`, { ids: [orderId] }), order, 200);
      },
      'POST /projects/:slug/sprints/proposal/apply ids': async () => ({
        foreign: post(`/projects/${OWN}/sprints/proposal/apply`, { ids: [await order(FOREIGN)] }),
        own: post(`/projects/${OWN}/sprints/proposal/apply`, { ids: await proposed() }),
        ownStatus: 201,
      }),
      'POST /projects/:slug/sprints/proposal/comment ids': async () => ({
        foreign: post(`/projects/${OWN}/sprints/proposal/comment`, { ids: [await order(FOREIGN)] }),
        own: post(`/projects/${OWN}/sprints/proposal/comment`, { ids: await proposed() }),
        ownStatus: 202,
      }),
    };

    try {
      for (const entry of TENANT_ID_FIELDS) {
        await t.test(key(entry), async () => {
          const prepare = scenarios[key(entry)];
          assert.ok(prepare, `${key(entry)}: Szenario in tenant-ids.test.ts ergänzen`);
          const scenario = await prepare();
          await refusedWithoutWrite(pool, api, scenario.foreign, entry.refused);
          const own = await api.call(scenario.own.method, scenario.own.path, scenario.own.body);
          assert.equal(own.status, scenario.ownStatus, `eigene ID: ${JSON.stringify(own.body)}`);
        });
      }

      // Gegenprobe: Eine Route ohne assertInProject übernimmt die fremde ID – der Test für sie scheitert.
      await t.test('Gegenprobe: Route ohne Prüfung fällt durch', async () => {
        const unchecked = await serveRoutes(admin, (router) =>
          router.post('/projects/:slug/gegenprobe', async (request, response) => {
            await pool.query(
              `INSERT INTO workflow_steps (project_slug, phase, position, agent_id) VALUES ($1, 'while_task', 9, $2)`,
              [request.params.slug, (request.body as { agentId: string }).agentId],
            );
            response.status(201).end();
          }),
        );
        try {
          const probe = post(`/projects/${OWN}/gegenprobe`, { agentId: await agent(FOREIGN) });
          await assert.rejects(refusedWithoutWrite(pool, unchecked, probe, 400), /statt 400\/404/);
        } finally {
          await unchecked.close();
        }
      });
    } finally {
      await api.close();
    }
  });
});
