import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Bug, Sprint } from '../../core/models.js';
import { BURYING_STATUSES, SEVERITIES, bugChanges, selectableSprints } from './bug-form.js';

const bug: Bug = {
  id: 'b1',
  title: 'Knopf kaputt',
  description: 'Beschreibung',
  severity: 'medium',
  status: 'open',
  source: 'manual',
  sprintId: null,
  fixNotes: null,
  category: null,
  createdAt: '2026-10-24T10:00:00Z',
  fixedAt: null,
};
const sprint = (id: string, status: Sprint['status']): Sprint => ({ id, name: id, status }) as Sprint;
const unchanged = {
  title: 'Knopf kaputt',
  description: 'Beschreibung',
  severity: 'medium',
  sprintId: '',
  fixNotes: '',
  category: '',
};

test('Bug bearbeiten: unverändertes Formular sendet nichts', () => {
  assert.deepEqual(bugChanges(bug, unchanged), {});
  // Leerzeichen am Rand zählen nicht, die API trimmt ebenso.
  assert.deepEqual(bugChanges(bug, { ...unchanged, title: '  Knopf kaputt ', description: 'Beschreibung\n' }), {});
});

test('Bug bearbeiten: nur geänderte Felder, leere Auswahl als null', () => {
  assert.deepEqual(bugChanges(bug, { ...unchanged, severity: 'high', sprintId: 's1', category: 'frontend' }), {
    severity: 'high',
    sprintId: 's1',
    category: 'frontend',
  });
  assert.deepEqual(bugChanges({ ...bug, sprintId: 's1', category: 'frontend' }, unchanged), {
    sprintId: null,
    category: null,
  });
  assert.deepEqual(bugChanges(bug, { ...unchanged, title: ' Neu ' }), { title: 'Neu' });
});

test('Sprints: keine abgeschlossenen oder abgebrochenen, ausser dem aktuellen des Bugs', () => {
  const sprints = [sprint('a', 'active'), sprint('p', 'planned'), sprint('c', 'completed'), sprint('x', 'cancelled')];
  assert.deepEqual(
    selectableSprints(sprints).map((entry) => entry.id),
    ['a', 'p'],
  );
  assert.deepEqual(
    selectableSprints(sprints, 'c').map((entry) => entry.id),
    ['a', 'p', 'c'],
  );
});

test('Schweregrade aufsteigend, Friedhof-Status vollständig', () => {
  assert.deepEqual(
    SEVERITIES.map((severity) => severity.value),
    ['low', 'medium', 'high', 'critical'],
  );
  assert.deepEqual([...BURYING_STATUSES].sort(), ['fixed', 'rejected', 'wontfix']);
});
