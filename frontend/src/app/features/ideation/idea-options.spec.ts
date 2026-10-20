import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ideaPhase, isOpenIdea } from './idea-options.js';

test('Offen sind nur Ideen, die weder angenommen noch abgelehnt sind', () => {
  for (const status of ['idea', 'considering', 'review', 'requested', 'drafting'])
    assert.equal(isOpenIdea({ status }), true, status);
  for (const status of ['accepted', 'implemented', 'rejected']) assert.equal(isOpenIdea({ status }), false, status);
});

test('Einordnung: „In Umsetzung“ nur mit vorhandenem, nicht abgeschlossenem Auftrag', () => {
  assert.equal(ideaPhase({ status: 'accepted' }, { status: 'in_progress' }), 'in_progress');
  assert.equal(ideaPhase({ status: 'accepted' }, { status: 'approval' }), 'in_progress');
  assert.equal(ideaPhase({ status: 'accepted' }, { status: 'done' }), 'implemented');
  assert.equal(ideaPhase({ status: 'implemented' }, null), 'implemented');
  // Abgelehnter oder fehlender Auftrag: nicht mehr in Umsetzung (Ideenseite: „Abgeschlossen“).
  assert.equal(ideaPhase({ status: 'accepted' }, { status: 'rejected' }), 'discarded');
  assert.equal(ideaPhase({ status: 'accepted' }, null), 'discarded');
  assert.equal(ideaPhase({ status: 'rejected' }, null), 'discarded');
  assert.equal(ideaPhase({ status: 'review' }, null), 'open');
});
