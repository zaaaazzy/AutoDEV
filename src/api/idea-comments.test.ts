import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentCommentPrompt, MAX_COMMENT, MAX_MENTIONS, parseComment, SYSTEM_PERSON } from './idea-comments.js';
import { requiredRole } from './route-table.test.js';

const agent = '0b6f1c7e-1d2a-4c3b-9e8f-112233445566';

test('Kommentar: Text und Erwähnungen werden geprüft, doppelte zusammengefasst', () => {
  assert.deepEqual(parseComment({ body: ' Hallo ' }), { text: 'Hallo', mentions: [] });
  assert.deepEqual(
    parseComment({
      body: '@Entwickler bitte prüfen',
      mentions: [
        { type: 'agent', id: agent },
        { type: 'agent', id: agent },
        { type: 'user', id: SYSTEM_PERSON },
      ],
    }),
    {
      text: '@Entwickler bitte prüfen',
      mentions: [
        { type: 'agent', id: agent },
        { type: 'user', id: SYSTEM_PERSON },
      ],
    },
  );
  assert.equal(parseComment({ body: 'x', mentions: [{ type: 'agent', id: SYSTEM_PERSON }] }), 'Ungültige Erwähnung.');
  assert.equal(parseComment({ body: 'x', mentions: [{ type: 'gruppe', id: agent }] }), 'Ungültige Erwähnung.');
  assert.equal(
    typeof parseComment({ body: 'x', mentions: Array(MAX_MENTIONS + 1).fill({ type: 'agent', id: agent }) }),
    'string',
  );
  assert.equal(typeof parseComment({ body: '' }), 'string');
  assert.equal(typeof parseComment({ body: 'y'.repeat(MAX_COMMENT + 1) }), 'string');
});

test('Kommentar: Anweisung an den Agent nennt Idee, Person und Text', () => {
  const prompt = agentCommentPrompt({ title: 'GitHub-Brücke' }, 'Patrick', 'Schätz das bitte neu.');
  assert.match(prompt, /Patrick/);
  assert.match(prompt, /„GitHub-Brücke“/);
  assert.match(prompt, /Schätz das bitte neu\./);
});

test('Kommentar schreiben gehört zur Planung', () => {
  assert.equal(requiredRole('POST', `/api/ideation/${agent}/comments`, {}), 'plan');
});
