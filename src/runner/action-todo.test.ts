import assert from 'node:assert/strict';
import { test } from 'node:test';
import { humanActionFor, manualTodo, parseActionLine } from './action-todo.js';

test('Fehler, die einen Menschen brauchen, werden als Aktion zusammengefasst', () => {
  assert.equal(humanActionFor('Error: 401 Unauthorized – API key missing'), 'Zugangsdaten hinterlegen bzw. anmelden');
  assert.equal(humanActionFor('Befehl abgelehnt: docker compose down'), 'Berechtigung bzw. Freigabe erteilen');
  assert.equal(humanActionFor('Abnahme: Live-Zertifikat nicht prüfbar'), 'Selbst prüfen (nicht automatisch prüfbar)');
  assert.equal(humanActionFor('TypeError: x is undefined at app.ts:12'), null);
});

test('Manuelle Abnahmepunkte werden kurz zusammengefasst', () => {
  assert.equal(manualTodo([]), null);
  assert.equal(
    manualTodo(['HTTPS im Browser öffnen', 'Push auf dem iPhone']),
    'Selbst prüfen: HTTPS im Browser öffnen; Push auf dem iPhone',
  );
  assert.ok(manualTodo(['x'.repeat(400)])!.length <= 160);
});

test('AKTION-Zeile der Problemanalyse', () => {
  assert.equal(
    parseActionLine('TITEL: a\nAKTION: API-Schlüssel in .env eintragen\n## Ursache'),
    'API-Schlüssel in .env eintragen',
  );
  assert.equal(parseActionLine('AKTION: keine'), null);
  assert.equal(parseActionLine('TITEL: nur Titel'), undefined);
});

test('AKTION: „keine“ mit Begründung ist keine offene Aktion', () => {
  for (const line of [
    'AKTION: keine – der Analyst dokumentiert den Befund',
    'AKTION: keine (Agent kann selbst beheben)',
    'AKTION: Keine: Code-Fehler',
    'AKTION: keine — Agent behebt selbst',
    'AKTION: keine - Agent behebt selbst',
    'AKTION: keine, Agent behebt selbst',
    'AKTION: keine. Agent behebt selbst',
    'AKTION: „keine – Code-Fehler“',
    'AKTION: nichts – Code-Fehler',
    'AKTION: n/a (Code-Fehler)',
    'AKTION: - (Code-Fehler)',
    'AKTION: -',
    'AKTION: keine.',
  ]) {
    assert.equal(parseActionLine(line), null, line);
  }
  assert.equal(
    parseActionLine('AKTION: Keine Datenbank-URL hinterlegt – bitte eintragen'),
    'Keine Datenbank-URL hinterlegt – bitte eintragen',
  );
  assert.equal(parseActionLine('AKTION: Nichtsdestotrotz Token erneuern'), 'Nichtsdestotrotz Token erneuern');
  assert.equal(parseActionLine('AKTION: Keine-Ahnung-Modus abschalten'), 'Keine-Ahnung-Modus abschalten');
});
