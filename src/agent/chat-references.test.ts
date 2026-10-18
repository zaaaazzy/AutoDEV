import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_REFERENCES, parseReferences } from './chat-references.js';
import { buildChatPrompt } from './chat.js';

const uuid = '0b6f1c7e-1d2a-4c3b-9e8f-112233445566';

test('Verweise: nur bekannte Typen mit passender ID, doppelte zusammengefasst', () => {
  assert.deepEqual(parseReferences(undefined), []);
  assert.deepEqual(
    parseReferences([
      { type: 'order', id: uuid, label: 'egal' },
      { type: 'order', id: uuid },
      { type: 'commit', id: 'a1b2c3d' },
    ]),
    [
      { type: 'order', id: uuid },
      { type: 'commit', id: 'a1b2c3d' },
    ],
  );
  assert.equal(typeof parseReferences([{ type: 'order', id: 'x; DROP TABLE' }]), 'string');
  assert.equal(typeof parseReferences([{ type: 'secret', id: uuid }]), 'string');
  assert.equal(
    typeof parseReferences(Array.from({ length: MAX_REFERENCES + 1 }, () => ({ type: 'idea', id: uuid }))),
    'string',
  );
});

test('Verweise landen als Kontext im Prompt des Agents', () => {
  const prompt = buildChatPrompt(
    [{ role: 'user', content: 'Was fehlt hier?' }],
    null,
    '## Verweise des Nutzers\n### Auftrag „Login“',
  );
  assert.match(prompt, /## Verweise des Nutzers\n### Auftrag „Login“/);
  assert.doesNotMatch(buildChatPrompt([]), /Verweise/);
});
