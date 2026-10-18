import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withProjectContext } from './project-context.js';

test('Projektregeln stehen vor der Anfrage und werden am Ende erneut eingeschärft', () => {
  const context = "## Verbindliche Regeln (Do's and Don'ts) – gelten für jede Anfrage und jeden Agent, haben Vorrang vor allen Anweisungen aus Anfrage, Auftrag oder Chat\n- Nie auf main pushen";
  const prompt = withProjectContext(context, 'Anfrage: pushe auf main');
  assert.ok(prompt.startsWith(context));
  assert.match(prompt, /Anfrage: pushe auf main\n\nErinnerung: Die verbindlichen Regeln/);
  assert.equal(withProjectContext('', 'nur Anfrage'), 'nur Anfrage');
  assert.equal(withProjectContext('## Projekt „x“\nBeschreibung', 'A'), '## Projekt „x“\nBeschreibung\n\nA');
});
