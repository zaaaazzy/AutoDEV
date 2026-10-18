import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applySuggestion, findTrigger, type MentionSource, suggestions } from './chat-mentions.js';

const source: MentionSource = {
  agents: [
    { id: 'a1', label: 'Tester' },
    { id: 'a2', label: 'Entwickler' },
  ],
  people: [{ id: 'u1', label: 'Tessa Muster' }],
  items: {
    order: [
      { id: 'o1', label: 'Login-Seite modernisieren', hint: 'Erledigt' },
      { id: 'o2', label: 'HTTPS umstellen', hint: 'Geplant' },
    ],
  },
};

test('„@“ schlägt Agents und Personen vor und filtert beim Tippen', () => {
  const trigger = findTrigger('Bitte @te', 9)!;
  assert.equal(trigger.kind, 'agent');
  assert.deepEqual(
    suggestions(trigger, source).map((entry) => [entry.kind, entry.label]),
    [
      ['agent', 'Tester'],
      ['person', 'Tessa Muster'],
    ],
  );
  assert.deepEqual(applySuggestion('Bitte @te', trigger, suggestions(trigger, source)[0]!), {
    text: 'Bitte',
    caret: 5,
    agentId: 'a1',
  });
  assert.deepEqual(applySuggestion('Bitte @te', trigger, suggestions(trigger, source)[1]!), {
    text: 'Bitte',
    caret: 5,
    reference: { type: 'user', id: 'u1', label: 'Tessa Muster' },
  });
});

test('„/“ zeigt Kategorien, „/auftrag/“ die Aufträge, Auswahl wird zum Verweis', () => {
  const category = findTrigger('/auf', 4)!;
  assert.deepEqual(
    suggestions(category, source).map((entry) => entry.label),
    ['Auftrag'],
  );
  const opened = applySuggestion('/auf', category, suggestions(category, source)[0]!);
  assert.deepEqual(opened, { text: '/auftrag/', caret: 9 });
  const item = findTrigger('/auftrag/login', 14)!;
  assert.equal(item.kind, 'item');
  const choice = suggestions(item, source)[0]!;
  assert.equal(choice.label, 'Login-Seite modernisieren');
  assert.deepEqual(applySuggestion('/auftrag/login prüfen', item, choice), {
    text: 'prüfen',
    caret: 0,
    reference: { type: 'order', id: 'o1', label: 'Login-Seite modernisieren' },
  });
});

test('Kein Auslöser mitten im Wort, unbekannte Kategorie ohne Vorschläge', () => {
  assert.equal(findTrigger('a/b', 3), null);
  assert.equal(findTrigger('mail@test', 9), null);
  assert.equal(findTrigger('/unbekannt/x', 12), null);
  assert.equal(findTrigger('Text', 4), null);
});
