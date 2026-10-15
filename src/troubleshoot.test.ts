import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTroubleshootPrompt, parseAnalysis } from './troubleshoot.js';

test('parses the bug title from the troubleshooter answer', () => {
  const parsed = parseAnalysis('TITEL: jest nicht installiert\n## Ursache\nFehlt.', 'Fallback');
  assert.equal(parsed.title, 'jest nicht installiert');
  assert.match(parsed.body, /^## Ursache/);
  assert.equal(parseAnalysis('## Ursache\nx', 'Fallback').title, 'Fallback');
});

test('includes failures and the answer format in the prompt', () => {
  const prompt = buildTroubleshootPrompt('', { title: 'A', description: 'B' }, ['### Tester\njest: command not found'], []);
  assert.match(prompt, /jest: command not found/);
  assert.match(prompt, /TITEL:/);
});
