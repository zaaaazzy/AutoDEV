import assert from 'node:assert/strict';
import { test } from 'node:test';
import { waitsForDependency } from './dependency.js';

test('waitsForDependency: offene Aufträge warten, bis der Auftrag, von dem sie abhängen, erledigt ist', () => {
  const planned = { dependsOn: 'b', dependsOnStatus: 'planned' as const, status: 'planned' as const };
  assert.ok(waitsForDependency(planned, null), 'Status vom Server, Abhängigkeit nicht geladen');
  assert.ok(waitsForDependency(planned, { status: 'in_progress' }), 'geladene Abhängigkeit zählt');
  assert.ok(!waitsForDependency(planned, { status: 'done' }), 'erledigte Abhängigkeit – kein Warten');
  assert.ok(!waitsForDependency({ ...planned, dependsOnStatus: 'done' }, null));
  assert.ok(waitsForDependency({ ...planned, status: 'backlog' }, null), 'auch im Backlog sichtbar');
  // Läuft, wartet auf Freigabe oder ist erledigt: der Hinweis wäre falsch.
  assert.ok(!waitsForDependency({ ...planned, status: 'in_progress' }, null));
  assert.ok(!waitsForDependency({ ...planned, status: 'done' }, null));
  assert.ok(!waitsForDependency({ dependsOn: null, status: 'planned' }, null), 'ohne Abhängigkeit nichts');
});
