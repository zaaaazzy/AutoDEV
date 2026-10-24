import assert from 'node:assert/strict';
import { test } from 'node:test';
import { escapeHtml, replaceInText } from './html.js';

test('escapeHtml: alle fünf Zeichen, die HTML oder Attribute verändern', () => {
  assert.equal(
    escapeHtml(`<a href="x" title='y'>&</a>`),
    '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;',
  );
});

test('replaceInText: nur Text, nie Tags, Attribute oder Linktexte', () => {
  const html = '<p title="Anna">Anna <a href="/Anna">Anna</a> <strong>Anna</strong></p>';
  assert.equal(
    replaceInText(html, (text) => text.replaceAll('Anna', 'X')),
    '<p title="Anna">X <a href="/Anna">Anna</a> <strong>X</strong></p>',
  );
});
