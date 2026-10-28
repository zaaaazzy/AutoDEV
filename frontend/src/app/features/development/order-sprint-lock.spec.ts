import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { DEVELOPMENT_STATUSES } from '../../shared/labels.js';
import { isSprintLockedDevelopmentStatus } from '../../../../../src/core/development-transitions.js';

const template = readFileSync(new URL('./order-detail.component.html', import.meta.url), 'utf8');

test('Sprint-Auswahl: gesperrt in Arbeit, in Freigabe und erledigt, sonst frei', () => {
  assert.deepEqual(DEVELOPMENT_STATUSES.filter((status) => isSprintLockedDevelopmentStatus(status)).sort(), [
    'approval',
    'done',
    'in_progress',
  ]);
  for (const status of ['backlog', 'planned', 'blocked', 'rejected']) {
    assert.equal(isSprintLockedDevelopmentStatus(status), false, status);
  }
});

test('Sprint-Auswahl im Auftragsdetail hängt an sprintLocked()', () => {
  const select = template.match(/<select[^>]*\[name\]="'sprint-' \+ item\.id"[^>]*>/)?.[0] ?? '';
  assert.ok(select, 'Sprint-Auswahl nicht gefunden');
  assert.match(select, /\[disabled\]="sprintLocked\(\)"/);
});
