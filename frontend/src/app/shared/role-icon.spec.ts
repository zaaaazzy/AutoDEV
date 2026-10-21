import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { AGENT_ROLES } from '../features/agents/agent-options.js';

const SOURCE = readFileSync(new URL('./role-icon.component.ts', import.meta.url), 'utf8');

/** Zeichenfolge der Symbole je `@case`; der Rest nach `@default` gehört der „Eigenen Rolle“. */
function iconShapes(): Map<string, string> {
  const shapes = new Map<string, string>();
  for (const part of SOURCE.split(/@(?=case \(|default \{)/).slice(1)) {
    const key = part.match(/^case \('(\w+)'\)/)?.[1] ?? 'custom';
    shapes.set(key, part.split('\n').slice(1, -2).join('').replace(/\s+/g, ' '));
  }
  return shapes;
}

test('Jede Agent-Rolle hat ein eigenes, unterscheidbares Symbol', () => {
  const shapes = iconShapes();
  const seen = new Map<string, string>();
  for (const { value } of AGENT_ROLES) {
    const shape = shapes.get(value);
    assert.ok(shape?.includes('<'), `Symbol für ${value} fehlt`);
    assert.equal(seen.get(shape), undefined, `${value} teilt das Symbol mit ${seen.get(shape)}`);
    seen.set(shape, value);
  }
  assert.ok(AGENT_ROLES.length >= 10);
});
