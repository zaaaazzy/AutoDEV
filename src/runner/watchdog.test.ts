import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluate, failureCause, failureProblem } from './watchdog.js';

const calm = { problems: [], notifiedAt: null };

test('reports new problems immediately, stays quiet while unchanged, reminds after six hours', () => {
  const first = evaluate(calm, ['Worker meldet sich nicht.'], 1_000);
  assert.equal(first.message?.title, '⚠ AIdeation: Problem erkannt');
  assert.equal(first.state.notifiedAt, 1_000);

  const same = evaluate(first.state, ['Worker meldet sich nicht.'], 60_000);
  assert.equal(same.message, null);

  const later = evaluate(first.state, ['Worker meldet sich nicht.'], 1_000 + 6 * 3600 * 1000);
  assert.equal(later.message?.title, '⚠ AIdeation: Problem besteht weiterhin');

  const added = evaluate(first.state, ['Worker meldet sich nicht.', 'Backup fehlt.'], 120_000);
  assert.match(added.message?.body ?? '', /Backup fehlt/);
});

test('reports recovery once and nothing when all is well', () => {
  const recovered = evaluate({ problems: ['x'], notifiedAt: 5 }, [], 10);
  assert.equal(recovered.message?.title, '✓ AIdeation läuft wieder');
  assert.equal(evaluate(recovered.state, [], 20).message, null);
});

test('Wächter: viele gescheiterte Agent-Schritte mit der häufigsten Ursache melden', () => {
  const failed = (output: string) => ({ status: 'failed', output });
  const passed = { status: 'passed', output: '' };
  const drive =
    'Unterbrochen: Laufwerk „External“ ist nicht verbunden – /Volumes/External/DevLog ist nicht erreichbar.';
  assert.equal(failureCause(drive), 'Laufwerk getrennt');
  assert.equal(
    failureCause('spawn claude ENOENT – Befehl „claude“ wurde im PATH des Workers nicht gefunden'),
    'Befehl nicht gefunden',
  );
  assert.equal(failureCause('Abbruch: Das Modell wiederholt sich („x…“).'), 'Wiederholungsschleife des Modells');
  assert.equal(failureCause('Tests rot'), 'Fehler im Auftrag');
  // Wenige Fehler oder überwiegend Erfolg: keine Meldung.
  assert.equal(failureProblem([failed(drive), failed(drive), passed]), null);
  assert.equal(failureProblem([...Array(5).fill(failed('x')), ...Array(6).fill(passed)]), null);
  assert.equal(
    failureProblem([failed(drive), failed(drive), failed(drive), failed('Tests rot'), failed('y'), passed]),
    'Auffällig viele Agent-Schritte scheitern (mehr als die Hälfte in 6 h, meist: Laufwerk getrennt).',
  );
});
