import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AcceptanceCheck, DevelopmentItem, TestEvidence } from '../core/models.js';
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
  const [entry] = orderAttention([order({ id: 'a', status: 'in_progress' })], checks);
  assert.equal(entry!.checks.length, 2);
  assert.equal(entry!.reasons[0]!.label, '2 Punkte von dir zu prüfen');
  const [todo] = orderAttention([order({ id: 'b', status: 'in_progress', actionTodo: 'Zugang geben' })], checks);
  assert.deepEqual(todo!.checks, []);
  assert.equal(todo!.reasons[0]!.label, 'Aktion notwendig');
});

const proof = (values: Partial<TestEvidence>): TestEvidence => ({
  id: 'e1',
  developmentId: 'a',
  position: 1,
  datei: 'src/a.test.ts',
  befehl: 'npm test -- a',
  grund: 'gegenprobe_fehlt',
  status: 'open',
  agentName: 'Tester',
  runId: null,
  checkedAt: null,
  allowed: true,
  running: false,
  ...values,
});

test('Offener Testnachweis: erledigter Auftrag ohne action_todo steht unter „Aktion notwendig“', () => {
  const done = order({ id: 'a', status: 'done', actionTodo: null });
  const [entry] = orderAttention([done], [], [proof({}), proof({ id: 'e2', developmentId: 'other' })]);
  assert.equal(entry!.item.id, 'a');
  assert.deepEqual(
    entry!.reasons.map((reason) => reason.label),
    ['Aktion notwendig', '1 Testnachweis offen'],
  );
  assert.deepEqual(
    entry!.evidence.map((item) => [item.datei, item.befehl, item.grund]),
    [['src/a.test.ts', 'npm test -- a', 'gegenprobe_fehlt']],
  );
  assert.equal(entry!.card.step, 'evidence');
  // Ohne Nachweis bleibt derselbe Auftrag ausserhalb von „Aktionen“.
  assert.deepEqual(orderAttention([done], []), []);
});

test('Testnachweis: grün abgehakt verschwindet, rot und nicht freigegeben bleiben sichtbar', () => {
  const done = order({ id: 'a', status: 'done' });
  assert.deepEqual(orderAttention([done], [], [proof({ status: 'passed', runId: 'r1' })]), []);
  const red = proof({ status: 'failed', runId: 'r1' });
  const refused = proof({ id: 'e2', befehl: 'npm test -- b', status: 'nicht_freigegeben' });
  const [entry] = orderAttention([done], [], [red, refused]);
  assert.equal(entry!.evidence.length, 2);
  assert.equal(entry!.reasons[1]!.label, '2 Testnachweise offen');
});

test('Testnachweis bei blockiertem Auftrag: Karte und Texte des Auftrags bleiben, Nachweis kommt dazu', () => {
  const blocked = order({ id: 'a', status: 'blocked', failure: 'Agent „Tester“ scheiterte: rot' });
  const [withProof] = orderAttention([blocked], [], [proof({})]);
  const [without] = orderAttention([blocked], []);
  assert.deepEqual(withProof!.card, without!.card);
  assert.deepEqual(withProof!.reasons.slice(0, without!.reasons.length), without!.reasons);
  assert.equal(withProof!.evidence.length, 1);
});

test('Schon freigegeben: kein Eintrag mehr unter „Rückmeldungen“ (wartet nur noch auf den Merge)', () => {
  const approved = order({ id: 'x', status: 'approval', reviewApprovedAt: '2026-10-22T16:00:00Z' });
  const open = order({ id: 'y', status: 'approval', reviewApprovedAt: null });
  assert.deepEqual(
    orderAttention([approved, open], []).map((entry) => entry.item.id),
    ['y'],
  );
});
