import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isOpenIdea } from './idea-options.js';

test('Offen sind nur Ideen, die weder angenommen noch abgelehnt sind', () => {
  for (const status of ['idea', 'considering', 'review', 'requested', 'drafting'])
    assert.equal(isOpenIdea({ status }), true, status);
  for (const status of ['accepted', 'implemented', 'rejected']) assert.equal(isOpenIdea({ status }), false, status);
});
