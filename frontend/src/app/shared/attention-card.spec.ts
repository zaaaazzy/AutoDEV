import assert from 'node:assert/strict';
import { test } from 'node:test';
import { attentionCard, blockedReason } from './attention-card.js';

/** Gespeicherte Meldung wie bei „Projektcode nur mit gefiltertem Environment“ (21.10.2026). */
const ACCEPTANCE = `Agent „Tester“ scheiterte:

**Testergebnis:** 1 Tests · 1 bestanden · 0 fehlgeschlagen

**Ausgabe (Ende):**

\`\`\`text
# tests 75
# pass 75
# fail 0
## Abnahme nicht bestanden
- DoD 1 „Jedes Akzeptanzkriterium ist durch einen automatischen Test belegt.“: Tests grün, aber die Abdeckung konnte nicht gemessen werden
\`\`\``;

test('Abgelehnte Abnahme: der echte Grund statt „1 Tests · 1 bestanden“, kein „Code-Fehler“', () => {
  const card = attentionCard({ status: 'blocked', kind: 'feature', failure: ACCEPTANCE }, 0);
  assert.match(
    card.why,
    /^Tester: Abnahme nicht bestanden – Tests grün, aber die Abdeckung konnte nicht gemessen werden/,
  );
  assert.doesNotMatch(card.why, /1 Tests/);
  assert.equal(card.step, 'retry');
});

test('Rote Tests: Anzahl und erster roter Test', () => {
  const failure = `Agent „Tester“ scheiterte:\n\n**Testergebnis:** 12 Tests · 10 bestanden · 2 fehlgeschlagen\n\n**Fehlgeschlagen:**\n- **Login mit falschem Passwort** (\`src/a.test.ts\`)\n  AssertionError`;
  assert.equal(blockedReason({ failure }), 'Tester: 2 Tests sind rot – „Login mit falschem Passwort“');
});

test('Analyse schlägt eine Code-Änderung vor: Vorschlag des Assistenten statt Programmieraufgabe für dich', () => {
  const card = attentionCard({
    status: 'blocked',
    kind: 'bug',
    failure: '',
    analysis: '## Ursache\nDer Review-Container bindet die .env ein.\n\n## Lösung\n- Skript anpassen',
    actionTodo: 'aideation-review.sh anpassen, review-slots.ts um --ignore-scripts erweitern',
  });
  assert.equal(card.step, 'suggestion');
  assert.equal(card.why, 'Der Review-Container bindet die .env ein.');
  assert.match(card.detail ?? '', /aideation-review\.sh anpassen/);
});

test('Echte Aufgabe für einen Menschen (Laufwerk, Zugang, Budget) bleibt eine Aufgabe', () => {
  const card = attentionCard({
    status: 'blocked',
    kind: 'feature',
    failure: 'Agent „Entwickler“ hat angehalten.',
    actionTodo: 'Projektordner bzw. Laufwerk nicht erreichbar – anschliessen, der Auftrag startet dann neu',
  });
  assert.equal(card.step, 'task');
  assert.match(card.detail ?? '', /Laufwerk/);
});

test('„keine – …“ der Analyse heisst: nichts zu beheben, einfach erneut versuchen', () => {
  const card = attentionCard({
    status: 'blocked',
    kind: 'feature',
    failure: 'Offene Änderungen im Arbeitsordner – auftrag/x nicht gemergt.',
    actionTodo: 'keine – der Analyst dokumentiert den Befund und schlägt eine Lösung vor',
  });
  assert.equal(card.step, 'retry');
  assert.equal(card.why, 'Offene Änderungen im Arbeitsordner – auftrag/x nicht gemergt.');
});

test('Behebungsauftrag läuft: nichts tun; Analyse läuft: warten', () => {
  assert.equal(attentionCard({ status: 'blocked', kind: 'feature', failure: 'x', fixStatus: 'planned' }).step, 'wait');
  assert.equal(
    attentionCard({ status: 'blocked', kind: 'feature', failure: 'x', analysisStatus: 'running' }).step,
    'analyzing',
  );
});

test('Freigabe, Projektregel, aus dem Sprint genommen, Prüfpunkte und Express-Rückfrage', () => {
  assert.equal(attentionCard({ status: 'approval' }).step, 'approve');
  const rule = attentionCard({
    status: 'rejected',
    failure: '**Vermerk:** Projektregel – Keine Cookies ohne Einwilligung – Auftrag anpassen oder verwerfen.',
  });
  assert.equal(rule.why, 'Verstösst gegen die Projektregel: Keine Cookies ohne Einwilligung.');
  assert.equal(
    attentionCard({ status: 'backlog', removedFromSprint: 'Sprint 9', removedFromSprintAt: '2026-10-21' }).step,
    'replan',
  );
  assert.equal(attentionCard({ status: 'planned' }, 2).why, '2 Punkte lassen sich nur von Hand prüfen.');
  assert.equal(attentionCard({ status: 'blocked', kind: 'express', actionTodo: 'Frage' }).step, 'question');
});

test('Sätze enden sauber: kein „:.“, richtige Einzahl bei einem weiteren Punkt', () => {
  const analysis =
    '## Ursache\nDer Aufbau enthält mehrere Lücken im Widerspruch zum Kommentar in review.sh:\n1. .env lesbar\n2. Haupt-DB';
  assert.doesNotMatch(blockedReason({ failure: '', analysis }), /:\.$/);
  const two = `${ACCEPTANCE.replace('\n```', '\n- DoD 2 „Manuelle Kriterien nur mit Begründung.“: fehlt\n```')}`;
  assert.match(blockedReason({ failure: two }), /\(und 1 weiterer Punkt\)$/);
});
