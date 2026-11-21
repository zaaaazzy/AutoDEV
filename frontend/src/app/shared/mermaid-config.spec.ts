import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { LIGHT_TOKENS, MERMAID_CONFIG, mermaidThemeVariables } from './mermaid-config.js';

const BASE_CSS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'styles', '01-base.css');

test('Mermaid: helle Standardwerte entsprechen den Tokens in 01-base.css', () => {
  const css = readFileSync(BASE_CSS, 'utf8');
  const root = css.slice(0, css.indexOf('@media (prefers-color-scheme: dark)'));
  for (const [token, value] of Object.entries(LIGHT_TOKENS)) {
    const match = root.match(new RegExp(`--${token}:\\s*(#[0-9a-fA-F]{3,6})\\s*;`));
    assert.ok(match, `Token --${token} fehlt in 01-base.css`);
    assert.equal(match[1].toLowerCase(), value, `--${token}`);
  }
});

test('Mermaid: Farben kommen aus den CSS-Variablen, fehlende fallen auf hell zurück', () => {
  const dark = mermaidThemeVariables((token) => (token === 'surface' ? ' #1c2320 ' : undefined), true);
  assert.equal(dark['background'], '#1c2320');
  assert.equal(dark['edgeLabelBackground'], '#1c2320');
  assert.equal(dark['primaryColor'], LIGHT_TOKENS['green-soft']);
  assert.equal(dark['darkMode'], true);
  assert.equal(MERMAID_CONFIG.themeVariables['background'], '#fff');
  assert.equal(MERMAID_CONFIG.themeVariables['darkMode'], false);
});
