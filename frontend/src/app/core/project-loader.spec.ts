import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ApiService } from './api.service.js';
import { emptyProjectData, type Agent, type DevelopmentItem } from './models.js';
import { fetchProjectData, keepFailedSections } from './project-loader.js';

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

test('Hintergrund-Refresh: Fehler ohne Meldung (z. B. Abdeckung) behalten ebenfalls alte Daten', async () => {
  const previous = { ...emptyProjectData(), coverage: { total: 80 } as never };
  const loaded = await fetchProjectData(fakeApi({ coverage: new Error('500') }), 'p');
  assert.equal(keepFailedSections(previous, loaded).coverage, previous.coverage);
});
