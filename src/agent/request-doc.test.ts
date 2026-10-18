import assert from 'node:assert/strict';
import { test } from 'node:test';
import { requestMarkdown, requestTitle } from './request-doc.js';

const at = new Date('2026-10-18T14:30:00');

test('Anfrage als Dokument: Titel mit Datum, Agent und Aufgabe', () => {
  const record = {
    request: 'Aufgabe „Tests ausführen“:\nFühre alle Tests aus.',
    answer: '69 Tests bestanden.',
    agentName: 'Tester',
    question: null,
    failed: false,
    at,
  };
  assert.equal(requestTitle(record), '18.10.2026 · Tester: Tests ausführen');
  const markdown = requestMarkdown(record);
  assert.match(markdown, /\*\*Übernommen von:\*\* Tester/);
  assert.match(markdown, /## Anfrage\n\*\*Aufgabe „Tests ausführen“\*\*\n\nFühre alle Tests aus\./);
  assert.match(markdown, /## Ergebnis\n69 Tests bestanden\./);
});

test('Freie Anfrage ohne Agent, fehlgeschlagen mit Rückfrage', () => {
  const record = {
    request: 'Warum ist die Seite langsam?',
    answer: '',
    agentName: null,
    question: 'Welche Seite?',
    failed: true,
    at,
  };
  assert.equal(requestTitle(record), '18.10.2026 · Assistent: Warum ist die Seite langsam?');
  assert.match(requestMarkdown(record), /fehlgeschlagen[\s\S]*## Rückfrage\nWelche Seite\?/);
});
