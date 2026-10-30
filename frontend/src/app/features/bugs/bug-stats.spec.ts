import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Bug } from '../../core/models.js';
import { bugStats, isBuried } from './bug-stats.js';

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
});

test('Statistik: Häufung je Bug-Kategorie (Git-Sync, CI, Runner) mit deutscher Bezeichnung, offen + begraben', () => {
  const stats = bugStats([
    bug({ category: 'git-sync' }),
    bug({ category: 'git-sync', status: 'fixed' }),
    bug({ category: 'git-sync', status: 'rejected' }),
    bug({ category: 'ci' }),
    bug({ category: 'runner', status: 'wontfix' }),
  ]);
  assert.deepEqual(
    stats.places.map((row) => [row.label, row.open, row.buried, row.total]),
    [
      ['Git-Sync', 1, 2, 3],
      ['CI', 1, 0, 1],
      ['Runner', 0, 1, 1],
    ],
  );
});
