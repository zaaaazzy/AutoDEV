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

test('Kapazität: Einstellung in Agent-Stunden, Token-Grenze aus dem Sprint-Budget, Historie nur zur Anzeige', () => {
  // Mehr oder weniger geschafft: die Einstellung gilt; der Median ohne Sprints ohne Laufzeit wird nur angezeigt.
  assert.deepEqual(
    capacityFrom(
      [
        { hours: 0.5, tokens: 300_000 },
        { hours: 0, tokens: 0 },
        { hours: 0.7, tokens: 100_000 },
        { hours: 99, tokens: 0 },
      ],
      4,
    ),
    { hours: 4, tokens: null, historyHours: 0.7 },
  );
  assert.deepEqual(capacityFrom([{ hours: 9, tokens: 1 }], 4, 2_000_000), {
    hours: 4,
    tokens: 2_000_000,
    historyHours: 9,
  });
  assert.deepEqual(capacityFrom([], 4, 0), { hours: 4, tokens: null, historyHours: null });
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
    { hours: 60, tokens: null, historyHours: null },
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
    { hours: 100, tokens: null, historyHours: null },
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
    { hours: 100, tokens: null, historyHours: null },
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
    { hours: 2, tokens: null, historyHours: null },
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
    { hours: 100, tokens: null, historyHours: null },
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
  const capacity = { hours: 8, tokens: null, historyHours: null } as const;
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
    { hours: 0.25, tokens: null, historyHours: 0.25 },
  );
  const selected = proposal.items.filter((item) => item.selected).map((item) => item.id);
  assert.ok(selected.includes('carry'));
  assert.equal(selected.filter((id) => id !== 'carry').length, 1, 'genau ein neuer trotz zu knapper Kapazität');
});

test('Rechnet mit kalibrierten Stunden und zeigt die gespeicherte Schätzung daneben', () => {
  const proposal = proposeSprint(
    [
      order({ id: 'old', title: 'Altbestand', effortHours: 0.4, rawEffortHours: 10 }),
      order({ id: 'new', title: 'Neu', effortHours: 0.3 }),
      order({ id: 'none', title: 'Ohne Schätzung', effortHours: null }),
    ],
    new Set(),
    { hours: 1.2, tokens: null, historyHours: null },
  );
  const byId = new Map(proposal.items.map((item) => [item.id, item]));
  assert.deepEqual([byId.get('old')?.rawHours, byId.get('new')?.rawHours, byId.get('none')?.rawHours], [10, 0.3, null]);
  // 0,4 + 0,3 + 0,5 (ohne Schätzung) = 1,2 Agent-Stunden passen genau.
  assert.equal(proposal.items.filter((item) => item.selected).length, 3);
  assert.equal(proposal.totals.hours, 1.2);
});
