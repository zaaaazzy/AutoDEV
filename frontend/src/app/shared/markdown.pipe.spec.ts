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

test('Markdown: eingerückte Fortsetzungszeile gehört zum Listenpunkt, nicht vor die Liste', () => {
  assert.equal(render('1. A\n   Detail\n2. B'), '<ol><li>A Detail</li><li>B</li></ol>');
});

test('Markdown: Leerzeile zwischen nummerierten Punkten beendet die Liste nicht', () => {
  assert.equal(render('1. a\n\n2. b'), '<ol><li>a</li><li>b</li></ol>');
});

test('Markdown: eingerückte Unterpunkte werden als verschachtelte Liste dargestellt', () => {
  assert.equal(
    render('1. Schritt\n   - Detail eins\n   - Detail zwei\n2. Weiter'),
    '<ol><li>Schritt<ul><li>Detail eins</li><li>Detail zwei</li></ul></li><li>Weiter</li></ol>',
  );
});

test('Markdown: Liste nach Leerzeile und Absatz endet, neue nummerierte Liste behält ihre Startnummer', () => {
  assert.equal(
    render('1. a\n\nZwischentext\n\n3. c'),
    '<ol><li>a</li></ol><p>Zwischentext</p><ol start="3"><li>c</li></ol>',
  );
});
