import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Bug } from '../../core/models.js';
import { BUG_CATEGORIES, bugCategoryLabel } from '../../shared/labels.js';
import { bugCategoryMatrix, bugCategoryPairs, bugStats, isBuried } from './bug-stats.js';

const bug = (fields: Partial<Bug>): Bug => ({
  id: crypto.randomUUID(),
  title: 'Bug',
  description: '',
  severity: 'medium',
  status: 'open',
  source: 'agent',
  sprintId: null,
  fixNotes: null,
  createdAt: '2026-10-19T00:00:00Z',
  fixedAt: null,
  ...fields,
});

test('Begraben sind behobene, nicht behobene und abgelehnte Bugs', () => {
  assert.deepEqual(
    (['open', 'in_progress', 'fixed', 'wontfix', 'rejected'] as const).map((status) => isBuried({ status })),
    [false, false, true, true, true],
  );
});

test('Statistik: wer, wo und in welchen Tests – offen und begraben getrennt gezählt', () => {
  const stats = bugStats([
    bug({
      source: 'test',
      status: 'fixed',
      title: 'Oberflächentest: Tabellen (Desktop)',
      description:
        'Der Oberflächentest **Tabellen sortieren** auf Desktop ist fehlgeschlagen. Testdatei: `full-ui.check.ts`\n## Befunde\n- ideation · Tabelle\n- development · Tabelle',
    }),
    bug({
      title: 'Tester: Checklisten',
      category: 'backend',
      description: 'not ok 7 - speichert Punkte\nin backend/src/checklists.test.ts',
    }),
    bug({ title: 'Entwickler: Routinen', source: 'agent', status: 'wontfix' }),
    bug({ title: 'Knopf fehlt', source: 'manual' }),
    bug({ title: 'Entwickler: Liste', description: 'Fehler in `frontend/src/app/list.ts` und e2e/tests/list.spec.ts' }),
  ]);
  assert.equal(stats.open, 3);
  assert.equal(stats.buried, 2);
  assert.deepEqual(
    stats.finders.map((row) => [row.label, row.open, row.buried]),
    [
      ['Entwickler', 1, 1],
      ['Tester', 1, 0],
      ['Von Hand gemeldet', 1, 0],
      ['Oberflächentest', 0, 1],
    ],
  );
  assert.deepEqual(
    stats.places.map((row) => [row.label, row.total]),
    [
      ['Ohne Zuordnung', 2],
      ['Backend', 1],
      ['E2E-Tests', 1],
      ['Frontend', 1],
      ['Seite Aufträge', 1],
      ['Seite Ideation', 1],
    ],
  );
  assert.deepEqual(stats.tests.map((row) => row.label).sort(), [
    'Tabellen sortieren (Desktop)',
    'checklists.test.ts',
    'full-ui.check.ts',
    'list.spec.ts',
    'speichert Punkte',
  ]);
  // „Nach Kategorie“ zählt die Bug-Kategorie, nicht den Bereich (Backend steht unter „Wo“).
  assert.deepEqual(
    stats.categories.map((row) => [row.label, row.open, row.buried]),
    [['Ohne Kategorie', 3, 2]],
  );
});

test('Statistik nach Kategorie: nur bestätigte Bug-Kategorie, Vorschläge und Bereich zählen nicht', () => {
  const stats = bugStats([
    bug({ bugCategory: 'ui', bugCategoryState: 'confirmed' }),
    bug({ bugCategory: 'ui', bugCategoryState: 'confirmed', status: 'fixed' }),
    bug({ bugCategory: 'git-sync', bugCategoryState: 'confirmed', status: 'rejected' }),
    bug({ bugCategorySuggested: 'api', bugCategoryState: 'suggested', category: 'backend' }),
  ]);
  assert.deepEqual(
    stats.categories.map((row) => [row.label, row.open, row.buried, row.total]),
    [
      ['Oberfläche', 1, 1, 2],
      ['Ohne Kategorie', 1, 0, 1],
      ['Git-Abgleich', 0, 1, 1],
    ],
  );
});

test('Kategorie × Sprint: alle acht Kategorien, „Kein Sprint“ zuletzt, Summe = alle Bugs', () => {
  const sprints = [
    { id: 's1', name: 'Sprint 1' },
    { id: 's2', name: 'Sprint 2' },
  ];
  const bugs = [
    bug({ bugCategory: 'ui', bugCategoryState: 'confirmed', sprintId: 's2' }),
    bug({ bugCategory: 'ui', bugCategoryState: 'confirmed', sprintId: 's2', status: 'fixed' }),
    bug({ bugCategory: 'ci', bugCategoryState: 'confirmed', sprintId: null }),
    bug({ bugCategory: 'api', bugCategoryState: 'confirmed', sprintId: 's1', status: 'wontfix' }),
    bug({ bugCategorySuggested: 'docs', bugCategoryState: 'suggested', sprintId: 's1' }),
  ];
  const pairs = bugCategoryPairs(bugs, sprints);
  assert.deepEqual(
    pairs.map((pair) => [pair.category, pair.sprintName, pair.open, pair.buried]),
    [
      ['api', 'Sprint 1', 0, 1],
      [null, 'Sprint 1', 1, 0],
      ['ui', 'Sprint 2', 1, 1],
      ['ci', null, 1, 0],
    ],
  );
  const matrix = bugCategoryMatrix(pairs);
  assert.deepEqual(
    matrix.sprints.map((sprint) => sprint.name),
    ['Sprint 1', 'Sprint 2', 'Kein Sprint'],
  );
  assert.deepEqual(
    matrix.rows.map((row) => row.label),
    [...BUG_CATEGORIES.map(bugCategoryLabel), 'Ohne Kategorie'],
  );
  const ui = matrix.rows.find((row) => row.category === 'ui')!;
  assert.deepEqual(ui.cells, [
    { open: 0, buried: 0 },
    { open: 1, buried: 1 },
    { open: 0, buried: 0 },
  ]);
  assert.deepEqual(matrix.totals, [
    { open: 1, buried: 1 },
    { open: 1, buried: 1 },
    { open: 1, buried: 0 },
  ]);
  assert.equal(matrix.total, bugs.length, 'Summe der Tabelle = Zahl aller Bugs');
});

test('Kategorie × Sprint: ohne Bugs leer, ohne unkategorisierte Bugs keine Zeile „Ohne Kategorie“', () => {
  assert.equal(bugCategoryMatrix([]).total, 0);
  const matrix = bugCategoryMatrix([{ category: 'budget', sprintId: null, sprintName: null, open: 2, buried: 0 }]);
  assert.equal(matrix.rows.length, BUG_CATEGORIES.length);
  assert.deepEqual(matrix.sprints, [{ id: null, name: 'Kein Sprint' }]);
  assert.equal(matrix.total, 2);
});
