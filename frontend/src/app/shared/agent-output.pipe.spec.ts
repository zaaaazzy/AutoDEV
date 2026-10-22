import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentOutputPipe } from './agent-output.pipe.js';

const render = (output: string | null | undefined): string => new AgentOutputPipe().transform(output);

test('Agent-Ausgabe: leer ergibt einen Hinweis', () => {
  assert.equal(render(null), '<p class="muted">Keine Inhalte vorhanden.</p>');
  assert.equal(render('  \n '), '<p class="muted">Keine Inhalte vorhanden.</p>');
});

test('Agent-Ausgabe: Befehle werden Karten mit Ergebnis, Text bleibt Markdown', () => {
  const html = render(
    ['Ich schaue mir das an.', '● Bash(npm run lint) … 6s', '  │ npm run lint', '  └ Lint sauber', '', 'Fertig.'].join(
      '\n',
    ),
  );
  assert.match(html, /^<p>Ich schaue mir das an\.<\/p>/);
  assert.match(html, /<div class="tool-call"><span class="tool-icon" aria-hidden="true">›<\/span>/);
  assert.match(html, /<code title="Bash\(npm run lint\)">Bash\(npm run lint\)<\/code>/, 'Dauer abgeschnitten');
  assert.match(html, /<span class="tool-result">Lint sauber<\/span>/);
  assert.doesNotMatch(html, /│/, 'Echo des Befehls nicht doppelt');
  assert.match(html, /<p>Fertig\.<\/p>$/);
});

test('Agent-Ausgabe: umbrochene Befehle und Ergebnisse werden zusammengesetzt', () => {
  const html = render(
    ['● Bash(git commit -m "lang', '  und weiter") … 2s', '  └ Ergebnis Zeile 1', '    Zeile 2'].join('\n'),
  );
  assert.match(html, /<code[^>]*>Bash\(git commit -m &quot;lang und weiter&quot;\)<\/code>/);
  assert.match(html, /<span class="tool-result">Ergebnis Zeile 1 Zeile 2<\/span>/);
});

test('Agent-Ausgabe: fehlgeschlagene und verweigerte Befehle werden markiert', () => {
  assert.match(render('✗ Bash(rm -rf /tmp/x)\n  └ ok'), /class="tool-call failed"/);
  assert.match(
    render('● Bash(docker kill x)\n  └ Permission denied'),
    /class="tool-call failed"><span class="tool-icon" aria-hidden="true">✕/,
  );
  assert.doesNotMatch(render('● Read(a.ts)\n  └ 12 Zeilen'), /failed/);
});

test('Agent-Ausgabe: Befehle und Ergebnisse werden escaped (kein HTML aus der Agent-Ausgabe)', () => {
  const html = render('● Bash(echo "<img src=x onerror=alert(1)>")\n  └ <script>alert(2)</script>');
  assert.doesNotMatch(html, /<img|<script/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /&lt;script&gt;alert\(2\)&lt;\/script&gt;/);
  assert.match(html, /title="Bash\(echo &quot;&lt;img/, 'auch im title-Attribut');
});

test('Agent-Ausgabe: sehr lange Befehle werden in der Anzeige gekürzt, der title behält alles', () => {
  const command = `Bash(echo ${'x'.repeat(600)})`;
  const html = render(`● ${command}\n  └ ok`);
  const shown = /<code [^>]*>([^<]*)<\/code>/.exec(html)![1]!;
  assert.equal(shown.length, 400);
  assert.match(html, new RegExp(`title="${command.replace(/[()]/g, '\\$&')}"`));
});
