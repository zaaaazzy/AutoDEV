# Tester-Abnahme scheitert nicht mehr an fehlender Abdeckungsmessung

Auftrag 5aff9b04 (Bugfix, mittel, 25.10.2026). Sprint 23.

## Problem

Der Tester sollte die Abdeckung messen und als `@@COVERAGE` melden. Sein Wächter sperrt den Befehl. Deshalb wertete er DoD-Punkt 1 („Jedes Akzeptanzkriterium ist durch einen automatischen Test belegt“) als nicht erfüllt, obwohl alle Tests grün waren. Der Auftrag war blockiert und jeder neue Versuch kostete einen vollen Lauf (Szenario c87687db: 75/75 Tests grün).

## Umsetzung

- **Abnahme** (`src/runner/acceptance.ts`, `src/runner/runner-steps.ts`): Neue Funktion `waiveUnmeasuredCoverage`. Ein DoD-Punkt, den der Tester nur wegen fehlender Abdeckungsmessung als nicht erfüllt meldet (Begründung nennt Abdeckung/Coverage und „nicht gemessen“, „blockiert“, „Wächter“, „Freigabe“ oder `null`), gilt als erfüllt. Voraussetzung: Jedes Akzeptanzkriterium ist erfüllt. `runStep` ruft sie vor `saveAcceptance` auf und vermerkt das im Schrittverlauf.
- **Gegenprobe**: Nennt die Begründung rote Tests, Fehlschläge oder ein Kriterium ohne Test, bleibt der Punkt nicht erfüllt. Ist ein Akzeptanzkriterium nicht erfüllt, wird nichts umgedeutet. Manuelle Punkte bleiben unberührt.
- **Prompt** (`src/runner/coverage.ts`): Die Abdeckung ist für den Tester keine Pflicht mehr („wenn möglich; AIdeation misst nach deinem Schritt selbst“).
- **Gemessene Abdeckung**: `measureCoverage` läuft unverändert nach dem Tester und speichert den Wert, auch ohne `@@COVERAGE` des Testers.
- **Wächter** (`src/agent/tool-permissions.ts`): unverändert, nicht gelockert.
- **Doku**: `docs/benutzerhandbuch-dashboard-agents.md` (Abschnitt zum Tester).

## Tests

Drei Tests „Abnahme: …“ in `src/runner/runner.test.ts`: bestanden bei grünen Tests ohne Tester-Messung (gespeicherte Abdeckung 82,5 % statt `null`), abgelehnt bei roten Tests oder unbelegtem Kriterium. Dazu `src/runner/acceptance.test.ts`.

## Geänderte Dateien

- `src/runner/acceptance.ts`, `src/runner/runner-steps.ts`, `src/runner/coverage.ts`
- `src/runner/runner.test.ts`
- `docs/benutzerhandbuch-dashboard-agents.md`

## Worauf zu achten ist

- Die Erkennung arbeitet mit Textmustern auf der Begründung des Testers. Formuliert er anders, bleibt der Punkt abgelehnt (sicherer Ausfall).
- Enthält die Begründung gleichzeitig ein Wort für rote Tests, gewinnt die Ablehnung.
- Der Entwickler meldete `npm test` zuletzt mit 1532/1532 grün; die Tests wurden hier nicht erneut ausgeführt.
