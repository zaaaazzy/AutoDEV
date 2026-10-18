import assert from 'node:assert/strict';
import { test } from 'node:test';
import { affectedFiles, capacityFrom, type PlanCandidate, proposeSprint, scoreOf } from './sprint-planner.js';

const base: PlanCandidate = {
  id: 'x',
  title: 'X',
  priority: 'medium',
  kind: 'feature',
  benefit: 5,
  cost: 5,
  effortHours: 4,
  tokenEstimate: null,
  followUpOf: null,
  troubled: false,
  carryOver: false,
  files: [],
};
const order = (patch: Partial<PlanCandidate>): PlanCandidate => ({ ...base, ...patch });

test('Bewertung: Priorität × Nutzen/Kosten, Bonus für Bugs, Malus für Blockierte', () => {
  assert.equal(scoreOf(order({ priority: 'high', benefit: 9, cost: 1 }), false), 15);
  assert.equal(scoreOf(order({ kind: 'bug' }), false), 4);
  assert.equal(scoreOf(order({ troubled: true }), false), 0.5);
});

test('Kapazität aus den letzten 3 Sprints (Median), ohne Historie aus der Einstellung', () => {
  assert.deepEqual(
    capacityFrom(
      [
        { hours: 10, tokens: 0 },
        { hours: 30, tokens: 0 },
        { hours: 20, tokens: 0 },
        { hours: 99, tokens: 0 },
      ],
      40,
    ),
    {
      hours: 20,
      tokens: null,
      source: 'history',
    },
  );
  assert.deepEqual(capacityFrom([], 40), { hours: 40, tokens: null, source: 'setting' });
});

test('Füllt bis zur Kapazität, Folgeauftrag nie vor seinem Vorgänger, übernommene immer dabei', () => {
  const proposal = proposeSprint(
    [
      order({ id: 'follow', title: 'Folge', priority: 'high', benefit: 10, cost: 0, followUpOf: 'base' }),
      order({ id: 'base', title: 'Basis', priority: 'low' }),
      order({ id: 'big', title: 'Gross', effortHours: 30 }),
      order({ id: 'carry', title: 'Übernommen', priority: 'low', effortHours: 50, carryOver: true }),
    ],
    new Set(),
    { hours: 60, tokens: null, source: 'setting' },
  );
  const selected = proposal.items.filter((item) => item.selected).map((item) => item.id);
  assert.deepEqual(selected, ['carry', 'base', 'follow']);
  assert.match(proposal.items.find((item) => item.id === 'big')!.reason, /Kapazität erreicht/);
  assert.equal(proposal.totals.hours, 58);
});

test('Aufträge mit denselben Dateien stehen direkt hintereinander', () => {
  const proposal = proposeSprint(
    [
      order({ id: 'a', priority: 'high', files: ['src/login.ts'] }),
      order({ id: 'b', priority: 'high', benefit: 4 }),
      order({ id: 'c', priority: 'medium', files: ['src/login.ts'] }),
    ],
    new Set(),
    { hours: 100, tokens: null, source: 'setting' },
  );
  assert.deepEqual(
    proposal.items.map((item) => item.id),
    ['a', 'c', 'b'],
  );
});

test('Betroffene Dateien aus den technischen Hinweisen', () => {
  assert.deepEqual(
    affectedFiles(
      '## Ziel\nx `src/a.ts`\n## Technische Hinweise (betroffene Dateien/Module)\n- `src/login.ts`\n- frontend/app/x.component.html\n## Akzeptanz',
    ),
    ['src/login.ts', 'frontend/app/x.component.html'],
  );
});

test('Autopilot: Sprint ist fertig, wenn nur noch Erledigtes oder „Aktion notwendig“ übrig ist', async () => {
  const { sprintSettled } = await import('../runner/sprint-autopilot.js');
  assert.equal(sprintSettled(['done', 'blocked']), true);
  assert.equal(sprintSettled(['done', 'planned']), false);
  assert.equal(sprintSettled(['in_progress']), false);
  assert.equal(sprintSettled([]), false);
});
