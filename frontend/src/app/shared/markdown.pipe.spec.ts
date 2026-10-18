import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MarkdownPipe } from './markdown.pipe.js';

const render = (markdown: string): string => new MarkdownPipe().transform(markdown);

test('Markdown: Tabellen werden mit Kopfzeile dargestellt, die Trennzeile entfällt', () => {
  const html = render('| Feld | Wert |\n| --- | --- |\n| Nutzen | **8** |\n\nDanach');
  assert.match(html, /<table><thead><tr><th>Feld<\/th><th>Wert<\/th><\/tr><\/thead>/);
  assert.match(html, /<td>Nutzen<\/td><td><strong>8<\/strong><\/td>/);
  assert.doesNotMatch(html, /---/);
  assert.match(html, /<p>Danach<\/p>/);
});

test('Markdown: https-Links sind klickbar, andere Ziele bleiben Text', () => {
  assert.match(
    render('[Folien](https://claude.ai/artifact/abc)'),
    /<a class="ext-link" href="https:\/\/claude\.ai\/artifact\/abc" target="_blank" rel="noopener noreferrer">Folien<\/a>/,
  );
  assert.doesNotMatch(render('[x](javascript:alert(1))'), /<a /);
  assert.match(render('Siehe https://example.com/a'), /<a class="ext-link" href="https:\/\/example\.com\/a"/);
});
