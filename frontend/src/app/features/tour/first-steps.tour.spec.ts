import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ApiService } from '../../core/api.service.js';
import { firstStepsTour } from './first-steps.tour.js';
import type { TourService } from './tour.service.js';

interface Setup {
  sprints: Array<{ id: string; name: string; status: string }>;
  development?: Array<{ id: string; sprintId: string; status: string }>;
  patchFails?: boolean;
}

/** Spielt die Aktion „Sprint jetzt starten“ mit nachgebautem Store und API durch. */
async function runStartSprint(setup: Setup) {
  const patches: Array<{ path: string; body: unknown }> = [];
  const notices: string[] = [];
  let nextCalls = 0;
  const api = {
    patch: async (path: string, body: unknown) => {
      patches.push({ path, body });
      if (setup.patchFails) throw new Error('409 Conflict');
      return {};
    },
  } as unknown as ApiService;
  const store = {
    data: () => ({ sprints: setup.sprints, development: setup.development ?? [] }),
    notice: { set: (value: string) => notices.push(value) },
    // Wie ProjectStore.perform: Fehler werden gemeldet, nicht weitergeworfen.
    perform: async (action: () => Promise<unknown>, success: string) => {
      try {
        await action();
        notices.push(success);
      } catch (error) {
        notices.push(`Fehler: ${(error as Error).message}`);
      }
    },
  };
  const tour = { store, next: () => nextCalls++ } as unknown as TourService;
  const step = firstStepsTour(api).find((entry) => entry.id === 'start-sprint');
  assert.ok(step?.action);
  await step.action.run(tour);
  return { patches, notices, nextCalls };
}

test('Tour: läuft schon ein Sprint, wird nichts gestartet und ohne Fehler weitergegangen', async () => {
  const result = await runStartSprint({
    sprints: [
      { id: 's1', name: 'Läuft', status: 'active' },
      { id: 's2', name: 'Geplant', status: 'planned' },
    ],
    development: [{ id: 'd1', sprintId: 's2', status: 'planned' }],
  });
  assert.equal(result.patches.length, 0);
  assert.deepEqual(result.notices, []);
  assert.equal(result.nextCalls, 1);
});

test('Tour: abgebrochene oder geprüfte Sprints werden nie gestartet', async () => {
  for (const status of ['cancelled', 'review', 'completed']) {
    const result = await runStartSprint({
      sprints: [{ id: 's1', name: 'Alt', status }],
      development: [{ id: 'd1', sprintId: 's1', status: 'planned' }],
    });
    assert.equal(result.patches.length, 0, status);
    assert.equal(result.nextCalls, 0, status);
    assert.match(result.notices[0] ?? '', /Lege zuerst einen Sprint an/, status);
  }
});

test('Tour: geplanter Sprint ohne geplante Aufträge wird nicht gestartet', async () => {
  const result = await runStartSprint({ sprints: [{ id: 's1', name: 'Leer', status: 'planned' }] });
  assert.equal(result.patches.length, 0);
  assert.equal(result.nextCalls, 0);
  assert.match(result.notices[0] ?? '', /Ziehe zuerst Aufträge/);
});

test('Tour: geplanter Sprint mit geplantem Auftrag wird gestartet', async () => {
  const result = await runStartSprint({
    sprints: [
      { id: 'old', name: 'Abgebrochen', status: 'cancelled' },
      { id: 's 1', name: 'Neu', status: 'planned' },
    ],
    development: [
      { id: 'd0', sprintId: 'old', status: 'planned' },
      { id: 'd1', sprintId: 's 1', status: 'planned' },
    ],
  });
  assert.deepEqual(result.patches, [{ path: '/api/sprints/s%201', body: { status: 'active' } }]);
  assert.equal(result.nextCalls, 1);
});

test('Tour: schlägt der Start fehl, bleibt die Tour stehen', async () => {
  const result = await runStartSprint({
    sprints: [{ id: 's1', name: 'Neu', status: 'planned' }],
    development: [{ id: 'd1', sprintId: 's1', status: 'planned' }],
    patchFails: true,
  });
  assert.equal(result.patches.length, 1);
  assert.equal(result.nextCalls, 0);
  assert.match(result.notices[0] ?? '', /Fehler: 409/);
});
