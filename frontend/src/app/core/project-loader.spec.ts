import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ApiService } from './api.service.js';
import { emptyProjectData, type Agent, type AgentRun, type DevelopmentItem } from './models.js';
import { fetchProjectData, keepFailedSections, runningOrdersChanged, runStepFinished } from './project-loader.js';

/** Fake-API: Antworten je Endpunkt, `Error` als Wert lässt die Anfrage scheitern. */
function fakeApi(responses: Record<string, unknown>): ApiService {
  return {
    projectPath: (slug: string) => `/api/projects/${slug}`,
    get: async (path: string) => {
      const key = path.split('/').pop() ?? '';
      const value = responses[key];
      if (value instanceof Error) throw value;
      return value ?? {};
    },
  } as unknown as ApiService;
}

const bugOrder = { id: 'o-bug', title: 'Bugfix', status: 'planned', bugId: 'b1' } as DevelopmentItem;
const plainOrder = { id: 'o-1', title: 'Feature', status: 'planned' } as DevelopmentItem;

test('Ladefehler bei /bugs: Bugfix-Aufträge bleiben sichtbar', async () => {
  const loaded = await fetchProjectData(
    fakeApi({ board: { development: [bugOrder, plainOrder] }, bugs: new Error('Timeout') }),
    'p',
  );
  assert.deepEqual(
    loaded.data.development.map((item) => item.id),
    ['o-bug', 'o-1'],
  );
  assert.ok(loaded.errors.bugs);
  assert.ok(loaded.failed.includes('bugs'));
});

test('Bugs geladen: Aufträge zu gelöschten Bugs werden ausgeblendet', async () => {
  const loaded = await fetchProjectData(
    fakeApi({ board: { development: [bugOrder, plainOrder] }, bugs: { bugs: [] } }),
    'p',
  );
  assert.deepEqual(
    loaded.data.development.map((item) => item.id),
    ['o-1'],
  );
});

test('Hintergrund-Refresh: fehlgeschlagene Bereiche behalten ihre alten Daten', async () => {
  const previous = { ...emptyProjectData(), agents: [{ id: 'a1' } as Agent], development: [plainOrder] };
  const loaded = await fetchProjectData(
    fakeApi({ board: { development: [bugOrder] }, agents: new Error('500'), bugs: { bugs: [{ id: 'b1' }] } }),
    'p',
  );
  const merged = keepFailedSections(previous, loaded);
  assert.deepEqual(
    merged.agents.map((agent) => agent.id),
    ['a1'],
  );
  assert.deepEqual(
    merged.development.map((item) => item.id),
    ['o-bug'],
  );
});

function run(id: string, ...statuses: string[]): AgentRun {
  return {
    id,
    title: id,
    status: 'running',
    startedAt: '2026-10-21T10:00:00Z',
    completedAt: null,
    steps: statuses.map((status, position) => ({ runId: id, position, command: '', status, output: '' })),
  };
}

test('Live-Läufe: Schritt wechselt von running auf fertig → Projekt nachladen', () => {
  assert.equal(runStepFinished([run('r1', 'passed', 'running')], [run('r1', 'passed', 'passed')]), true);
  assert.equal(runStepFinished([run('r1', 'running')], [run('r1', 'failed')]), true);
  // Lauf verschwindet aus der Liste: ebenfalls nicht mehr laufend.
  assert.equal(runStepFinished([run('r1', 'running')], []), true);
});

test('Live-Läufe: unverändert laufend oder neu gestartet → kein Reload über die Läufe', () => {
  assert.equal(runStepFinished([run('r1', 'running')], [run('r1', 'running')]), false);
  assert.equal(runStepFinished([run('r1', 'passed')], [run('r1', 'passed'), run('r2', 'running')]), false);
  assert.equal(runStepFinished([], []), false);
});

test('Worker-Status: geänderte Menge laufender Aufträge wird erkannt', () => {
  const a = { title: 'A', startedAt: '2026-10-21T10:00:00Z' };
  const b = { title: 'B', startedAt: '2026-10-21T10:05:00Z' };
  assert.equal(runningOrdersChanged([a], []), true, 'Auftrag fertig');
  assert.equal(runningOrdersChanged([], [b]), true, 'nächster Auftrag gestartet');
  assert.equal(runningOrdersChanged([a], [b]), true, 'Auftrag gewechselt');
  assert.equal(runningOrdersChanged([a], [{ ...a, startedAt: '2026-10-21T11:00:00Z' }]), true, 'neu gestartet');
  assert.equal(runningOrdersChanged([a, b], [b, a]), false, 'nur Reihenfolge anders');
  assert.equal(runningOrdersChanged([], []), false);
});

test('Hintergrund-Refresh: Fehler ohne Meldung (z. B. Abdeckung) behalten ebenfalls alte Daten', async () => {
  const previous = { ...emptyProjectData(), coverage: { total: 80 } as never };
  const loaded = await fetchProjectData(fakeApi({ coverage: new Error('500') }), 'p');
  assert.equal(keepFailedSections(previous, loaded).coverage, previous.coverage);
});
