import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { AGENT_ROLES } from './agent-options.js';
import { parseRoleTexts, roleTextView, roleTextViews } from './agent-role-text.js';

const file = new URL('../../../../public/data/agent-rollen-texte.json', import.meta.url);
const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
const texts = parseRoleTexts(raw);

test('Rollentexte: jeder Schlüssel aus AGENT_ROLES hat einen vollständigen Eintrag', () => {
  for (const role of AGENT_ROLES) {
    const entry = texts[role.value];
    assert.ok(entry, `Eintrag für ${role.value} fehlt oder ist unvollständig`);
    assert.equal(entry.rolle, role.label, `Anzeigename von ${role.value} passt nicht zu AGENT_ROLES`);
    assert.ok(entry.beschreibung.trim() && entry.nutzen.trim());
  }
  assert.equal(Object.keys(raw as object).length, AGENT_ROLES.length, 'Keine Einträge ohne Rolle in AGENT_ROLES');
});

test('Rollentexte: author zeigt „Auftragsautor“ und beschreibt Anforderungen aus Ideen', () => {
  const view = roleTextView('author', texts);
  assert.equal(view.label, 'Auftragsautor');
  assert.match(view.text?.beschreibung ?? '', /Ideen/);
  assert.match(view.text?.beschreibung ?? '', /Anforderungen/);
});

test('Rollentexte: unbekannte Rolle fällt ohne Fehler auf den neutralen Text zurück', () => {
  assert.deepEqual(roleTextView('kuenftige_rolle', texts), {
    key: 'kuenftige_rolle',
    label: 'kuenftige_rolle',
    text: null,
  });
  assert.equal(roleTextView('toString', texts).text, null);
  assert.equal(roleTextView('author', {}).text, null);
});

test('Rollentexte: ohne Schlüssel alle Rollen in der Reihenfolge von AGENT_ROLES', () => {
  assert.deepEqual(
    roleTextViews(null, texts).map((view) => view.key),
    AGENT_ROLES.map((role) => role.value),
  );
  assert.deepEqual(
    roleTextViews('tester', texts).map((view) => view.label),
    ['Tester'],
  );
});

test('Rollentexte: unvollständige oder fremde Daten werden verworfen', () => {
  assert.deepEqual(parseRoleTexts(null), {});
  assert.deepEqual(parseRoleTexts([1, 2]), {});
  assert.deepEqual(parseRoleTexts({ author: { rolle: 'A', beschreibung: '', nutzen: 'n' } }), {});
});
