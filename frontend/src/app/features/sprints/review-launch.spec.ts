import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DevelopmentItem, ReviewSlot, SprintCommit } from '../../core/models.js';
import { sprintLabel } from '../../shared/labels.js';
import {
  commitOptionLabel,
  nextOpenOrders,
  reviewStarting,
  reviewStatusText,
  sprintReviewable,
  sprintReviewSlot,
} from './review-launch.js';

const hash = (digit: string) => digit.repeat(40);

test('Sprint-Review nur bei geplanten, aktiven und Review-Sprints einbinden', () => {
  assert.equal(sprintReviewable('planned'), true);
  assert.equal(sprintReviewable('active'), true);
  assert.equal(sprintReviewable('review'), true);
  assert.equal(sprintReviewable('completed'), false, 'abgeschlossene Sprints fragen nichts ab');
  assert.equal(sprintReviewable('cancelled'), false);
});

function slot(values: Partial<ReviewSlot>): ReviewSlot {
  return {
    slot: 1,
    enabled: true,
    url: 'http://localhost:4301',
    status: 'idle',
    message: null,
    projectSlug: 'alpha',
    label: null,
    commit: null,
    developmentId: null,
    kind: null,
    startedAt: null,
    ...values,
  };
}

function item(values: Partial<DevelopmentItem>): DevelopmentItem {
  return { id: 'x', title: 'x', description: '', status: 'planned', priority: 'medium', sprintId: 's1', ...values };
}

test('Statustext wechselt mit jedem Status des Review-Containers', () => {
  const texts = (['idle', 'requested', 'starting', 'running', 'failed', 'stopping'] as const).map((status) =>
    reviewStatusText({ status, message: null }),
  );
  assert.equal(new Set(texts).size, texts.length);
  assert.equal(reviewStatusText({ status: 'requested', message: null }), 'Stand wird ausgecheckt …');
  assert.equal(reviewStatusText({ status: 'running', message: null }), 'Review läuft');
});

test('Fehlgeschlagener Start zeigt die erste Zeile der Meldung des Servers', () => {
  assert.equal(
    reviewStatusText({ status: 'failed', message: 'npm ci scheiterte\nlanges Protokoll …' }),
    'Fehler: npm ci scheiterte',
  );
  assert.equal(reviewStatusText({ status: 'failed', message: '  ' }), 'Fehler: Start fehlgeschlagen');
});

test('Ladeanimation nur, solange der Container angefordert ist oder startet', () => {
  assert.equal(reviewStarting(slot({ status: 'requested' })), true);
  assert.equal(reviewStarting(slot({ status: 'starting' })), true);
  assert.equal(reviewStarting(slot({ status: 'running' })), false);
  assert.equal(reviewStarting(slot({ status: 'failed' })), false);
  assert.equal(reviewStarting(null), false);
});

test('Der hier gestartete Container hat Vorrang vor anderen Ständen des Sprints', () => {
  const slots = [
    slot({ slot: 1, status: 'running', commit: hash('a'), kind: 'manual' }),
    slot({ slot: 2, status: 'starting', commit: hash('b'), kind: 'manual' }),
    slot({ slot: 3, status: 'running', projectSlug: 'beta', commit: hash('c') }),
  ];
  const commits = [{ hash: hash('a') }, { hash: hash('b') }];
  assert.equal(sprintReviewSlot(slots, 'alpha', commits, 2)?.slot, 2);
  assert.equal(sprintReviewSlot(slots, 'alpha', commits, null)?.slot, 1);
  // Fremdes Projekt zählt nie, auch nicht als gestarteter Container – dann gilt der laufende manuelle des Projekts.
  assert.equal(sprintReviewSlot(slots, 'alpha', [], 3)?.slot, 1);
  assert.equal(sprintReviewSlot([slots[2]!], 'alpha', [], 3), null);
});

test('Nicht gemergte Stände sind mit ◌ markiert, gemergte nicht', () => {
  const commit: SprintCommit = { hash: hash('a'), subject: 'feat: Login', date: '', developmentId: null, merged: true };
  assert.equal(commitOptionLabel(commit, '20.10.2026'), 'feat: Login · aaaaaaa · 20.10.2026');
  assert.equal(commitOptionLabel({ ...commit, merged: false }, '20.10.2026'), '◌ feat: Login · aaaaaaa · 20.10.2026');
});

test('Vorschau zeigt höchstens fünf offene Aufträge des Sprints, laufende zuerst', () => {
  const items = [
    item({ id: 'done', status: 'done', sprintRank: 0 }),
    item({ id: 'other', sprintId: 's2', sprintRank: 0 }),
    ...[5, 4, 3, 2, 1, 6].map((rank) => item({ id: `r${rank}`, sprintRank: rank })),
    item({ id: 'running', status: 'in_progress', sprintRank: 9 }),
  ];
  assert.deepEqual(
    nextOpenOrders(items, 's1').map((entry) => entry.id),
    ['running', 'r1', 'r2', 'r3', 'r4'],
  );
  assert.deepEqual(nextOpenOrders([], 's1'), []);
});

test('Sprintname ohne doppeltes „Sprint“', () => {
  assert.equal(sprintLabel('Sprint 1'), 'Sprint 1');
  assert.equal(sprintLabel('Checkout'), 'Sprint Checkout');
});
