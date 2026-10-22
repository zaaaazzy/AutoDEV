import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  affectedFiles,
  capacityFrom,
  type PlanCandidate,
  planRoadmap,
  proposeSprint,
  scoreOf,
} from './sprint-planner.js';

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

test('Kapazität: Median der letzten 3 Sprints, aber nie unter der Einstellung', () => {
  // Weniger geschafft als eingestellt (Ist-Stunden sind Rechenzeit): die Einstellung gilt, ohne Token-Grenze.
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
    { hours: 40, tokens: null, source: 'setting' },
  );
  assert.deepEqual(
    capacityFrom(
      [
        { hours: 0.25, tokens: 6_000_000 },
        { hours: 0.2, tokens: 5_000_000 },
      ],
      40,
    ),
    { hours: 40, tokens: null, source: 'setting' },
  );
  // Mehr geschafft: die Historie hebt die Kapazität an, Ist-Tokens als Median; Sprints ohne Laufzeit zählen nicht.
  assert.deepEqual(
    capacityFrom(
      [
        { hours: 50, tokens: 300_000 },
        { hours: 0, tokens: 0 },
        { hours: 70, tokens: 100_000 },
      ],
      40,
    ),
    { hours: 60, tokens: 200_000, source: 'history' },
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

test('Folgeauftrag steht nie vor seinem Vorgänger, auch wenn er höher bewertet ist', () => {
  const proposal = proposeSprint(
    [
      order({ id: 'follow', priority: 'high', benefit: 10, cost: 0, followUpOf: 'base' }),
      order({ id: 'other', priority: 'medium' }),
      order({ id: 'base', priority: 'low' }),
    ],
    new Set(),
    { hours: 100, tokens: null, source: 'setting' },
  );
  const rank = (id: string) => proposal.items.find((item) => item.id === id)!.rank!;
  assert.ok(rank('base') < rank('follow'));
  // Knappe Kapazität: der Vorgänger kommt zuerst, der Folgeauftrag passt danach nicht mehr.
  const tight = proposeSprint(
    [
      order({ id: 'follow', priority: 'high', benefit: 10, cost: 0, followUpOf: 'base', effortHours: 1 }),
      order({ id: 'base', priority: 'low', effortHours: 10 }),
    ],
    new Set(),
    { hours: 2, tokens: null, source: 'setting' },
  );
  assert.deepEqual(
    tight.items.filter((item) => item.selected).map((item) => item.id),
    ['base'],
  );
  assert.match(tight.items.find((item) => item.id === 'follow')!.reason, /Kapazität erreicht/);
});

test('Gleiche Dateien auch zusammen mit Folgeaufträgen direkt hintereinander', () => {
  const proposal = proposeSprint(
    [
      order({ id: 'x', priority: 'high', benefit: 9, files: ['src/api.ts'] }),
      order({ id: 'free', priority: 'high', benefit: 8 }),
      order({ id: 'y', priority: 'low', files: ['src/api.ts'], followUpOf: 'done-before' }),
    ],
    new Set(['done-before']),
    { hours: 100, tokens: null, source: 'setting' },
  );
  const ids = proposal.items.map((item) => item.id);
  assert.equal(ids.indexOf('y'), ids.indexOf('x') + 1);
});

test('Roadmap: 3 Sprints, kein Auftrag doppelt, Folgeauftrag nach dem Sprint seines Vorgängers', () => {
  const candidates = [
    order({ id: 'a', priority: 'high' }),
    order({ id: 'b', priority: 'high', followUpOf: 'a' }),
    order({ id: 'c', priority: 'medium' }),
    order({ id: 'd', priority: 'medium' }),
    order({ id: 'e', priority: 'low' }),
    order({ id: 'f', priority: 'low' }),
    order({ id: 'g', priority: 'low' }),
    order({ id: 'carry', priority: 'low', carryOver: true }),
  ];
  const capacity = { hours: 8, tokens: null, source: 'setting' } as const;
  const roadmap = planRoadmap(candidates, new Set(), capacity);
  assert.equal(roadmap.length, 3);
  const ids = roadmap.flatMap((sprint) => sprint.items.map((item) => item.id));
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(roadmap[0]!.items.some((item) => item.id === 'carry'));
  const sprintOf = (id: string) => roadmap.findIndex((sprint) => sprint.items.some((item) => item.id === id));
  assert.ok(sprintOf('a') <= sprintOf('b'));
  for (const sprint of roadmap) assert.ok(sprint.totals.hours <= 8);
  // Deterministisch: gleiche Eingabe, gleiche Roadmap.
  assert.deepEqual(planRoadmap(candidates, new Set(), capacity), roadmap);
});

test('Autopilot: Sprint ist fertig, wenn nur noch Erledigtes oder „Aktion notwendig“ übrig ist', async () => {
  const { sprintSettled } = await import('../runner/sprint-autopilot.js');
  const item = (status: string, actionTodo: string | null = null) => ({ status, actionTodo });
  assert.equal(sprintSettled([item('done'), item('blocked', 'Zugangsdaten hinterlegen')]), true);
  assert.equal(sprintSettled([item('done'), item('blocked')]), false, 'blockiert ohne Aktion: Fehler beheben');
  assert.equal(sprintSettled([item('done'), item('planned')]), false);
  assert.equal(sprintSettled([item('in_progress')]), false);
  assert.equal(sprintSettled([item('backlog')]), false);
  assert.equal(sprintSettled([]), false);
});

test('Übernommene Aufträge allein füllen keinen Sprint: mindestens ein neuer kommt immer dazu', () => {
  const proposal = proposeSprint(
    [
      order({ id: 'carry', title: 'Blockiert aus dem Vorsprint', carryOver: true }),
      order({ id: 'new', title: 'Neu', effortHours: 2 }),
      order({ id: 'second', title: 'Noch einer', effortHours: 2 }),
    ],
    new Set(),
    { hours: 0.25, tokens: null, source: 'history' },
  );
  const selected = proposal.items.filter((item) => item.selected).map((item) => item.id);
  assert.ok(selected.includes('carry'));
  assert.equal(selected.filter((id) => id !== 'carry').length, 1, 'genau ein neuer trotz zu knapper Kapazität');
});
