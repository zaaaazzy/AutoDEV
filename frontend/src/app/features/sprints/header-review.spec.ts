import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ReviewCommit, ReviewSlot } from '../../core/models.js';
import { groupReviewCommits, headerReviewSlot, reviewCommitBadge, shortUrl } from './header-review.js';

const hash = (digit: string) => digit.repeat(40);

function commit(values: Partial<ReviewCommit>): ReviewCommit {
  return {
    hash: hash('a'),
    subject: 'Merge auftrag/1a2b3c4d-x: Auftrag',
    date: '2026-10-21T18:00:00+02:00',
    developmentId: null,
    merged: true,
    title: 'Auftrag',
    orderStatus: 'done',
    sprintId: 's9',
    sprintName: 'Sprint 9',
    sprintStatus: 'active',
    ...values,
  };
}

function slot(values: Partial<ReviewSlot>): ReviewSlot {
  return {
    slot: 1,
    enabled: true,
    url: 'http://localhost:4201',
    status: 'idle',
    message: null,
    projectSlug: null,
    label: null,
    commit: null,
    developmentId: null,
    kind: null,
    startedAt: null,
    ...values,
  };
}

test('Kopfzeile: Stände nach Sprint gruppiert, Reihenfolge des Servers bleibt', () => {
  const groups = groupReviewCommits([
    commit({ hash: hash('1'), sprintId: 's9', sprintName: 'Sprint 9' }),
    commit({ hash: hash('2'), sprintId: 's8', sprintName: 'Sprint 8' }),
    commit({ hash: hash('3'), sprintId: 's9', sprintName: 'Sprint 9' }),
  ]);
  assert.deepEqual(
    groups.map((group) => [group.sprintName, group.commits.map((entry) => entry.hash[0])]),
    [
      ['Sprint 9', ['1', '3']],
      ['Sprint 8', ['2']],
    ],
  );
});

test('Kopfzeile: Hinweis je Stand – im Sprint, wartet auf Freigabe, eigener Branch', () => {
  assert.equal(reviewCommitBadge({ merged: true, orderStatus: 'approval' }).tone, 'merged');
  assert.equal(reviewCommitBadge({ merged: false, orderStatus: 'approval' }).text, 'wartet auf Freigabe');
  assert.equal(reviewCommitBadge({ merged: false, orderStatus: 'in_progress' }).tone, 'branch');
});

test('Kopfzeile: gezeigter Container – hier gestartet, sonst manuell, sonst laufende Freigabe des Projekts', () => {
  const approval = slot({ slot: 1, projectSlug: 'dev-log', status: 'running', kind: 'approval' });
  const manual = slot({ slot: 2, projectSlug: 'dev-log', status: 'starting', kind: 'manual' });
  const foreign = slot({ slot: 3, projectSlug: 'mainty', status: 'running', kind: 'manual' });
  assert.equal(headerReviewSlot([approval, manual, foreign], 'dev-log', null)?.slot, 2);
  assert.equal(headerReviewSlot([approval, manual, foreign], 'dev-log', 1)?.slot, 1);
  assert.equal(headerReviewSlot([approval, foreign], 'dev-log', null)?.slot, 1);
  assert.equal(headerReviewSlot([foreign, slot({ slot: 2 })], 'dev-log', null), null);
  // Ein Container, der gerade beendet wird, zählt nicht als laufende Vorschau.
  assert.equal(
    headerReviewSlot([slot({ projectSlug: 'dev-log', status: 'stopping', kind: 'approval' })], 'dev-log', null),
    null,
  );
});

test('Kopfzeile: Link ohne Protokoll', () => {
  assert.equal(shortUrl('http://localhost:4202/'), 'localhost:4202');
});
