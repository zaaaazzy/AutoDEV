import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseRisks } from './risk-list.js';

test('Markdown-Liste mit fettem Titel und Unterpunkten wird in Einträge zerlegt', () => {
  const parsed = parseRisks(
    [
      'Diese Bugs passen zum Auftrag:',
      '',
      '- **Login-Schleife nach Passwortwechsel**: Session wurde nicht erneuert',
      '  - Nicht wiederholen: Cookie vor dem Redirect setzen',
      '- **Doppelte E-Mails** – Versand lief zweimal',
      '  Folgezeile zur Erklärung',
    ].join('\n'),
  );
  assert.equal(parsed.intro, 'Diese Bugs passen zum Auftrag:');
  assert.equal(parsed.none, false);
  assert.deepEqual(parsed.items, [
    {
      title: 'Login-Schleife nach Passwortwechsel',
      tag: null,
      details: ['Session wurde nicht erneuert', 'Nicht wiederholen: Cookie vor dem Redirect setzen'],
    },
    { title: 'Doppelte E-Mails', tag: null, details: ['Versand lief zweimal', 'Folgezeile zur Erklärung'] },
  ]);
});

test('Ungefilterte Bugliste: Etikett in eckigen Klammern wird abgetrennt', () => {
  const parsed = parseRisks('Bekannte Bugs (nicht gefiltert):\n- [offen / high] Absturz beim Export – Datei zu gross');
  assert.deepEqual(parsed.items, [{ title: 'Absturz beim Export', tag: 'offen / high', details: ['Datei zu gross'] }]);
});

test('Nummerierte Listen und Sternchen gelten ebenfalls als Einträge', () => {
  const parsed = parseRisks('1. Erstes Risiko\n2) Zweites Risiko\n* Drittes Risiko');
  assert.deepEqual(
    parsed.items.map((item) => item.title),
    ['Erstes Risiko', 'Zweites Risiko', 'Drittes Risiko'],
  );
});

test('„Keine relevanten Bugs“ und leerer Text ergeben keine Einträge', () => {
  assert.equal(parseRisks('Keine relevanten Bugs.').none, true);
  assert.equal(parseRisks('Keine bekannten Bugs im Projekt.').none, true);
  assert.deepEqual(parseRisks(''), { intro: '', items: [], none: false });
  assert.deepEqual(parseRisks(null).items, []);
});
