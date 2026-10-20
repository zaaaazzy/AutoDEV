import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handoffTarget, parseHandoffs, PHASE_SQL_ORDER, WORKFLOW_PHASES } from './workflow-phases.js';

const agents = [
  { id: 'a', name: 'Entwickler' },
  { id: 'b', name: 'Tester' },
  { id: 'c', name: 'Dokumentierer', handoffTo: null },
];

test('Nachrichten: an den nächsten, an einen benannten oder den eingestellten Agent', () => {
  const handoffs = parseHandoffs(
    'Fertig.\n@@NACHRICHT: Bitte die Migration zuerst prüfen.\n@@nachricht an Dokumentierer: Neue API /api/x dokumentieren.\n@@NACHRICHT:   ',
  );
  assert.deepEqual(handoffs, [
    { to: null, text: 'Bitte die Migration zuerst prüfen.' },
    { to: 'Dokumentierer', text: 'Neue API /api/x dokumentieren.' },
  ]);
  assert.equal(handoffTarget(handoffs[0]!, agents[0]!, agents)?.id, 'b');
  assert.equal(handoffTarget(handoffs[1]!, agents[0]!, agents)?.id, 'c');
  // Beim Absender eingestellter Empfänger hat Vorrang vor „dem nächsten“.
  assert.equal(handoffTarget(handoffs[0]!, { ...agents[0]!, handoffTo: 'c' }, agents)?.id, 'c');
  // Letzter Agent ohne Empfänger: Nachricht geht nirgends hin.
  assert.equal(handoffTarget(handoffs[0]!, agents[2]!, agents), null);
});

test('Phasen-Reihenfolge für SQL deckt alle Spalten ab', () => {
  for (const [index, phase] of WORKFLOW_PHASES.entries())
    assert.match(PHASE_SQL_ORDER, new RegExp(`'${phase}' THEN ${index}`));
});
