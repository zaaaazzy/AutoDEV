import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DevelopmentItem, ReviewSlot } from '../../core/models.js';
import {
  freeReviewSlot,
  launchOrderReview,
  orderReviewSlot,
  reviewInstanceLabel,
  reviewLaunchable,
} from './review-box.js';

const slot = (values: Partial<ReviewSlot>): ReviewSlot => ({
  slot: 1,
  enabled: true,
  url: 'http://localhost:4301',
  status: 'idle',
  message: null,
  projectSlug: 'devlog',
  label: null,
  commit: null,
  developmentId: null,
  kind: null,
  startedAt: null,
  ...values,
});
const order = { id: 'o1', title: 'Auftrag' } as DevelopmentItem;

test('Container des Auftrags: freie Container und fremde Aufträge zählen nicht', () => {
  const idle = slot({ slot: 1, developmentId: 'o1', status: 'idle' });
  const other = slot({ slot: 2, developmentId: 'o2', status: 'running' });
  const mine = slot({ slot: 3, developmentId: 'o1', status: 'starting' });
  assert.equal(orderReviewSlot([idle, other, mine], 'o1'), mine);
  assert.equal(orderReviewSlot([idle, other], 'o1'), null);
  assert.equal(orderReviewSlot(undefined, 'o1'), null, 'ohne geladenen Stand');
  assert.equal(orderReviewSlot(null, 'o1'), null);
});

test('Jeder belegte Status zeigt den Container an (auch angefordert, fehlgeschlagen, beendend)', () => {
  for (const status of ['requested', 'starting', 'running', 'failed', 'stopping'] as const) {
    assert.equal(orderReviewSlot([slot({ developmentId: 'o1', status })], 'o1')?.status, status);
  }
});

test('Freier Container: eingeschaltet und leer', () => {
  assert.equal(freeReviewSlot(slot({ status: 'idle' })), true);
  assert.equal(freeReviewSlot(slot({ status: 'idle', enabled: false })), false);
  assert.equal(freeReviewSlot(slot({ status: 'running' })), false);
});

test('Statuszeile je Container-Status', () => {
  assert.equal(reviewInstanceLabel(slot({ slot: 2, status: 'running' })), 'Review 2 läuft');
  assert.equal(
    reviewInstanceLabel(slot({ slot: 2, status: 'starting' })),
    'Review 2 startet (Abhängigkeiten, Datenbank-Kopie) …',
  );
  assert.equal(reviewInstanceLabel(slot({ slot: 2, status: 'failed' })), 'Review 2 konnte nicht starten');
  assert.equal(reviewInstanceLabel(slot({ status: 'requested' })), 'Wird gestartet …');
  assert.equal(reviewInstanceLabel(slot({ status: 'stopping' })), 'Wird gestartet …');
  assert.equal(reviewInstanceLabel(null), 'Wird gestartet …');
});

test('Start-Knopf ohne Container und nach einem gescheiterten Start, sonst nicht', () => {
  assert.equal(reviewLaunchable(null), true);
  assert.equal(reviewLaunchable(slot({ status: 'failed' })), true, 'nach Fehler: neu starten');
  for (const status of ['requested', 'starting', 'running', 'stopping'] as const) {
    assert.equal(reviewLaunchable(slot({ status })), false, status);
  }
});

function deps(active: () => boolean, showReview: () => Promise<unknown> = async () => true) {
  const calls: string[] = [];
  return {
    calls,
    deps: {
      activeProject: () => 'devlog',
      isActive: (slug: string) => {
        calls.push(`isActive:${slug}`);
        return active();
      },
      showReview: async (item: DevelopmentItem) => {
        calls.push(`show:${item.id}`);
        return showReview();
      },
      refresh: async () => {
        calls.push('refresh');
      },
    },
  };
}

test('Start lädt danach den Stand für dasselbe Projekt nach', async () => {
  const { calls, deps: launch } = deps(() => true);
  await launchOrderReview(launch, order);
  assert.deepEqual(calls, ['show:o1', 'isActive:devlog', 'refresh']);
});

test('Start lädt nichts nach, wenn inzwischen das Projekt gewechselt wurde', async () => {
  const { calls, deps: launch } = deps(() => false);
  await launchOrderReview(launch, order);
  assert.deepEqual(calls, ['show:o1', 'isActive:devlog']);
});

test('Abgelehnte Rückfrage oder Serverfehler: Stand trotzdem nachladen (Box zeigt den Fehler-Container)', async () => {
  const { calls, deps: launch } = deps(() => true, async () => false);
  await launchOrderReview(launch, order);
  assert.deepEqual(calls, ['show:o1', 'isActive:devlog', 'refresh']);
});

test('Wirft der Start, wird nichts nachgeladen und der Fehler weitergereicht', async () => {
  const { calls, deps: launch } = deps(
    () => true,
    async () => {
      throw new Error('kaputt');
    },
  );
  await assert.rejects(launchOrderReview(launch, order), /kaputt/);
  assert.deepEqual(calls, ['show:o1']);
});
