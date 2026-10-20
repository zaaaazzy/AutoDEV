import assert from 'node:assert/strict';
import test from 'node:test';
import { MarkdownPipe } from './markdown.pipe.js';

test('mermaid blocks become diagram placeholders, other code stays code', () => {
  const html = new MarkdownPipe().transform('```mermaid\nflowchart LR\n  A --> B\n```\n\n```\nnpm test\n```');
  assert.match(
    html,
    /<div class="mermaid-diagram"><pre class="mermaid-source">flowchart LR\n {2}A --&gt; B<\/pre><\/div>/,
  );
  assert.match(html, /<pre><code>npm test<\/code><\/pre>/);
});
