import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DevelopmentItem } from '../../core/models.js';
import { bulkSelectable, canRetry } from './order-bulk.js';

const order = (patch: Partial<DevelopmentItem>): DevelopmentItem =>
  ({ id: 'a', title: 'A', status: 'backlog', kind: 'feature', priority: 'medium', ...patch }) as DevelopmentItem;

test('Erneut versuchen wie die Route /retry: blockiert, abgelehnt oder aus dem Sprint genommen, nie Express', () => {
  assert.equal(canRetry(order({ status: 'blocked' })), true);
  assert.equal(canRetry(order({ status: 'rejected' })), true);
  assert.equal(canRetry(order({ status: 'backlog', removedFromSprintAt: '2026-10-22' })), true);
  assert.equal(canRetry(order({ status: 'backlog' })), false);
  assert.equal(canRetry(order({ status: 'in_progress', removedFromSprintAt: '2026-10-22' })), false);
  assert.equal(canRetry(order({ status: 'blocked', kind: 'express' })), false);
});

test('Häkchen nur an offenen Aufträgen: nicht an erledigten und nicht an Express-Anfragen', () => {
  assert.equal(bulkSelectable(order({ status: 'blocked' })), true);
  assert.equal(bulkSelectable(order({ status: 'in_progress' })), true);
  assert.equal(bulkSelectable(order({ status: 'done' })), false);
  assert.equal(bulkSelectable(order({ status: 'planned', kind: 'express' })), false);
});
