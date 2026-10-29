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

/** Alle Attributwerte der Ausgabe: Erzeugtes Markup darf nie darin landen. */
const attributes = (html: string): string[] => [...html.matchAll(/="([^"]*)"/g)].map((match) => match[1]!);

test('Markdown: Rohes HTML wird escaped, nie ausgeführt', () => {
  assert.equal(
    render('<img src=x onerror=alert(1)> & "q"'),
    '<p>&lt;img src=x onerror=alert(1)&gt; &amp; &quot;q&quot;</p>',
  );
});

test('Markdown: verschachtelte Links und Hervorhebungen bleiben aus Attributen draussen', () => {
  for (const input of [
    '[a](https://x.com/[b](https://y.com))',
    '[a](https://x.com/**b**)',
    '[t](https://a.b/`c` https://d.e/f)',
    '**https://a.com/"onmouseover=alert(1)//**',
    '[x](https://a.com/*b* "c) https://d.com/*e*',
  ]) {
    const html = render(input);
    for (const value of attributes(html)) assert.doesNotMatch(value, /[<>"]/, `${input} → ${html}`);
    // Jedes geöffnete Tag wird geschlossen (keine zerbrochene Struktur).
    for (const tag of ['a', 'span', 'strong', 'em', 'code'])
      assert.equal(
        (html.match(new RegExp(`<${tag}[ >]`, 'g')) ?? []).length,
        (html.match(new RegExp(`</${tag}>`, 'g')) ?? []).length,
        `${tag} in ${html}`,
      );
  }
  assert.equal(
    render('[a](https://x.com/**b**)'),
    '<p><a class="ext-link" href="https://x.com/**b**" target="_blank" rel="noopener noreferrer">a</a></p>',
  );
});

test('Markdown: Platzhalter aus der Eingabe wirken nicht', () => {
  assert.equal(render('`a` @@CODE0@@ 0'), '<p><code>a</code> @@CODE0@@ 0</p>');
});

test('Markdown: Links mit Code und Fettschrift im Text, &-Zeichen im Ziel', () => {
  assert.equal(
    render('[`code` im **Link**](https://x.com/a?b=1&c=2)'),
    '<p><a class="ext-link" href="https://x.com/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer"><code>code</code> im <strong>Link</strong></a></p>',
  );
});

test('Markdown: App-Links, Dateipfade (auch fett und als Linkziel) und URLs ohne Satzzeichen', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  assert.match(
    render(`[Auftrag](#development/${id})`),
    new RegExp(`<a class="doc-link app-link" href="#development/${id}">Auftrag</a>`),
  );
  assert.doesNotMatch(render('[x](#development/"onclick)'), /<a /);
  assert.equal(
    render('Siehe **src/api/bugs.ts** und [Doku](docs/workflows.md).'),
    '<p>Siehe <strong><code class="path">src/api/bugs.ts</code></strong> und <span class="doc-link">Doku<span class="doc-link-url"> (<code class="path">docs/workflows.md</code>)</span></span>.</p>',
  );
  assert.match(
    render('Log: https://example.com/a.'),
    /href="https:\/\/example\.com\/a"[^>]*>https:\/\/example\.com\/a<\/a>\.<\/p>$/,
  );
});
