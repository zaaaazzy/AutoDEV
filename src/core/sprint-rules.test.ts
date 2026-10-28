import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  canActivateSprint,
  canChangeSprintStatus,
  canCompleteSprint,
  canDeleteSprint,
  completeSprintConflict,
  hasOtherActiveSprint,
} from './sprint-rules.js';

test('Statuswechsel: Tabelle wie bisher in PATCH /sprints/:id', () => {
  assert.equal(canChangeSprintStatus('planned', 'active'), true);
  assert.equal(canChangeSprintStatus('completed', 'active'), true);
  assert.equal(canChangeSprintStatus('cancelled', 'planned'), true);
  assert.equal(canChangeSprintStatus('cancelled', 'active'), false);
  assert.equal(canChangeSprintStatus('review', 'completed'), false);
  assert.equal(canChangeSprintStatus('planned', 'completed'), false);
});

test('Abschluss: laufende vor wartenden Aufträgen melden', () => {
  assert.equal(completeSprintConflict(0, 0), null);
  assert.match(completeSprintConflict(1, 2) ?? '', /laufen noch/);
  assert.match(completeSprintConflict(0, 2) ?? '', /^2 Auftrag/);
  const active = { id: 's', status: 'active' };
  assert.equal(canCompleteSprint(active, []), true);
  assert.equal(canCompleteSprint(active, [{ sprintId: 's', status: 'approval' }]), false);
});

test('Löschen und anderer aktiver Sprint', () => {
  assert.equal(canDeleteSprint({ id: 's', status: 'completed', gitSync: null }, []), true);
  assert.equal(canDeleteSprint({ id: 's', status: 'completed', gitSync: 'pending' }, []), false);
  assert.equal(canDeleteSprint({ id: 's', status: 'planned' }, [{ sprintId: 's', status: 'in_progress' }]), false);
  const planned = { id: 's', status: 'planned' };
  assert.equal(hasOtherActiveSprint(planned, [planned]), false);
  assert.equal(hasOtherActiveSprint(planned, [{ id: 't', status: 'active' }]), true);
  assert.equal(canActivateSprint({ id: 's', status: 'active' }, []), false, 'schon aktiv');
});
