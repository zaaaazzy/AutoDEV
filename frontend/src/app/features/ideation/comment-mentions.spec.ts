import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  activeMentions,
  type CommentMention,
  findAtTrigger,
  highlightMentions,
  initials,
  insertMention,
  rankMentions,
} from './comment-mentions.js';

const entwickler: CommentMention = { type: 'agent', id: 'a1', name: 'Entwickler' };
const tester: CommentMention = { type: 'agent', id: 'a2', name: 'Tester' };
const patrick: CommentMention = { type: 'user', id: 'u1', name: 'Patrick Moser' };

test('Erwähnung: „@“ vor dem Cursor öffnet die Vorschläge, auch mit Leerzeichen im Namen', () => {
  assert.deepEqual(findAtTrigger('Hallo @Ent', 10), { query: 'Ent', start: 6, end: 10 });
  assert.deepEqual(findAtTrigger('@Patrick M', 10), { query: 'Patrick M', start: 0, end: 10 });
  assert.equal(findAtTrigger('mail@example.ch', 15), null);
  assert.equal(findAtTrigger('kein Zeichen', 12), null);
});

test('Erwähnung: Vorschläge nach Namensanfang, Agents zuerst', () => {
  assert.deepEqual(rankMentions([patrick, tester, entwickler], ''), [tester, entwickler, patrick]);
  assert.deepEqual(rankMentions([patrick, tester, entwickler], 'mos'), [patrick]);
  assert.deepEqual(rankMentions([patrick, tester, entwickler], 'te'), [tester]);
  assert.deepEqual(rankMentions([patrick, tester, entwickler], 'wick'), [entwickler]);
});

test('Erwähnung: Auswahl ersetzt das angefangene Wort, gelöschte Erwähnungen fallen weg', () => {
  const trigger = findAtTrigger('Bitte @ent prüfen', 10)!;
  assert.deepEqual(insertMention('Bitte @ent prüfen', trigger, 'Entwickler'), {
    text: 'Bitte @Entwickler prüfen',
    caret: 18,
  });
  assert.deepEqual(activeMentions('@Entwickler schau mal', [entwickler, tester, entwickler]), [entwickler]);
});

test('Erwähnung: im Text als Bubble hervorgehoben, Initialen für den Avatar', () => {
  const html = highlightMentions('<p>@Entwickler und @Patrick Moser</p>', [entwickler, patrick]);
  assert.match(html, /<span class="mention-chip agent">⚙︎Entwickler<\/span>/);
  assert.match(html, /<span class="mention-chip user">@Patrick Moser<\/span>/);
  assert.equal(initials('Patrick Moser'), 'PM');
  assert.equal(initials('Visionär'), 'V');
});
