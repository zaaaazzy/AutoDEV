import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AcceptanceCheck, DevelopmentItem } from '../core/models.js';
import { orderAttention } from './order-attention.js';

const order = (values: Partial<DevelopmentItem>): DevelopmentItem => ({
  id: 'a',
  title: 'Auftrag',
  description: '',
  status: 'planned',
  priority: 'medium',
  sprintId: null,
  ...values,
});

const manualCheck = (developmentId: string, position: number): AcceptanceCheck => ({
  developmentId,
  kind: 'criterion',
  position,
  text: `Punkt ${position}`,
  status: 'manual',
  note: null,
  checkedAt: null,
});

test('Normale Aufträge brauchen keine Aktion', () => {
  assert.deepEqual(orderAttention([order({}), order({ id: 'b', status: 'done' })], []), []);
});

test('Blockiert, Freigabe, abgelehnt und aus dem Sprint genommen landen unter „Aktionen“', () => {
  const entries = orderAttention(
    [
      order({ id: 'blocked', status: 'blocked' }),
      order({ id: 'approval', status: 'approval' }),
      order({ id: 'rejected', status: 'rejected' }),
      order({ id: 'removed', status: 'backlog', removedFromSprintAt: '2026-01-01', removedFromSprint: 'S1' }),
    ],
    [],
  );
  assert.deepEqual(
    entries.map((entry) => entry.item.id),
    ['blocked', 'approval', 'rejected', 'removed'],
  );
  assert.equal(entries[3]!.reasons[0]!.label, 'Aus Sprint „S1“ genommen');
  // Der Status „Aktion notwendig“ steht schon im Etikett – nicht noch einmal als Grund.
  assert.deepEqual(entries[0]!.badges, []);
});

test('Erledigte Aufträge mit altem Aktionshinweis brauchen keine Aktion mehr', () => {
  assert.deepEqual(orderAttention([order({ status: 'done', actionTodo: 'x', removedFromSprintAt: 'y' })], []), []);
});

test('Manuelle Prüfpunkte werden gezählt, ausser es wartet eine Aktion', () => {
  const checks = [manualCheck('a', 1), manualCheck('a', 2), manualCheck('b', 1)];
  const [entry] = orderAttention([order({ id: 'a', status: 'done' })], checks);
  assert.equal(entry!.checks.length, 2);
  assert.equal(entry!.reasons[0]!.label, '2 Punkte von dir zu prüfen');
  const [todo] = orderAttention([order({ id: 'b', status: 'approval', actionTodo: 'Zugang geben' })], checks);
  assert.deepEqual(todo!.checks, []);
  assert.deepEqual(
    todo!.reasons.map((reason) => reason.label),
    ['Wartet auf Freigabe'],
  );
});

test('Geplante und laufende Aufträge warten mit Prüfpunkten noch nicht auf dich', () => {
  const checks = [manualCheck('planned', 1), manualCheck('running', 1), manualCheck('approved', 1)];
  const entries = orderAttention(
    [
      order({ id: 'planned', status: 'planned' }),
      order({ id: 'running', status: 'in_progress' }),
      order({ id: 'approved', status: 'approval', reviewApprovedAt: '2026-10-22T16:00:00Z' }),
    ],
    checks,
  );
  assert.deepEqual(entries, []);
});

test('Schon freigegeben: kein Eintrag mehr unter „Rückmeldungen“ (wartet nur noch auf den Merge)', () => {
  const approved = order({ id: 'x', status: 'approval', reviewApprovedAt: '2026-10-22T16:00:00Z' });
  const open = order({ id: 'y', status: 'approval', reviewApprovedAt: null });
  assert.deepEqual(
    orderAttention([approved, open], []).map((entry) => entry.item.id),
    ['y'],
  );
});
