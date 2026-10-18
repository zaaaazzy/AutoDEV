import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSprintCommentPrompt, plainComment } from './sprint-comment.js';

test('Sprint-Kommentar: Prompt nennt Aufträge in Reihenfolge und verlangt 3–5 Sätze ohne Änderungen', () => {
  const prompt = buildSprintCommentPrompt('', { name: 'Sprint 4', capacityHours: 20, hours: 6, tokens: 1200 }, [
    { title: 'Login', score: 4, reason: 'Priorität hoch', hours: 4, tokens: 1200 },
    { title: 'Logout', score: 2, reason: 'folgt auf „Login“', hours: 2, tokens: null },
  ]);
  assert.match(prompt, /1\. Login \(Score 4, 4 h, 1200 Tokens\)/);
  assert.match(prompt, /2\. Logout \(Score 2, 2 h\) – folgt auf „Login“/);
  assert.match(prompt, /3 bis 5 Sätze/);
  assert.match(prompt, /ändere nichts/);
});

test('Sprint-Kommentar: reiner Text, höchstens 5 Sätze', () => {
  assert.equal(
    plainComment('## Ziel\n- **Login** fertigstellen.\n- Risiko: `src/a.ts` wird zweimal geändert!'),
    'Ziel Login fertigstellen. Risiko: src/a.ts wird zweimal geändert!',
  );
  const long = plainComment('Eins. Zwei. Drei. Vier. Fünf. Sechs. Sieben.');
  assert.equal(long, 'Eins. Zwei. Drei. Vier. Fünf.');
  assert.equal(plainComment('   '), null);
});
