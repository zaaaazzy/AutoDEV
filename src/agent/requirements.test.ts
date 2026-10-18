import assert from 'node:assert/strict';
import { test } from 'node:test';
import { shortTitle, TITLE_MAX } from '../core/validation.js';
import { splitTitle } from './requirements.js';

test('Auftragsautor: „@@TITEL:“ wird zum kurzen Titel und verschwindet aus der Anforderung', () => {
  const { title, text } = splitTitle('@@TITEL: „Dunkelmodus für Einstellungen“\n## Ziel\nDunkel.');
  assert.equal(title, 'Dunkelmodus für Einstellungen');
  assert.equal(text, '## Ziel\nDunkel.');
  assert.deepEqual(splitTitle('## Ziel\nOhne Titel'), { title: null, text: '## Ziel\nOhne Titel' });
  assert.ok((splitTitle(`@@TITEL: ${'sehr lang '.repeat(20)}`).title ?? '').length <= TITLE_MAX);
});

test('shortTitle kürzt an einer Wortgrenze mit Auslassungszeichen', () => {
  assert.equal(shortTitle('Kurz genug'), 'Kurz genug');
  const long = shortTitle('Login-Seite modernisieren mit einem sehr langen Titel, der unbedingt umbrechen muss');
  assert.ok(long.length <= 60);
  assert.ok(long.endsWith('…'));
  assert.ok(!long.includes(', …'));
});
