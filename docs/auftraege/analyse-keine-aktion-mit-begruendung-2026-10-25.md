# Analyse setzt „keine – …“ als offene Aktion an den Auftrag

Auftrag 017be1a1 (Bugfix, Schwere niedrig, 25.10.2026). Sprint 23. Gefunden auf der Seite „Aktionen“ am 21.10.2026.

## Ursache

`parseActionLine` (`src/runner/action-todo.ts`) wertete die Zeile `AKTION:` nur dann als „keine Aktion“, wenn dahinter genau „keine“, „nichts“, „-“ oder „n/a“ stand (optional mit Punkt). Mit Begründung („keine – der Analyst dokumentiert den Befund …“, „keine (Agent kann selbst beheben)“) wurde der ganze Satz als offene Aktion in `action_todo` gespeichert. Unter „Aktionen“ wirkte der Auftrag, als warte er auf einen Menschen.

## Umsetzung

- **Neue Konstante `NO_ACTION`** (`src/runner/action-todo.ts`): Das Schlüsselwort (`keine`, `nichts`, `-`, `n/a`, ohne Beachtung der Groß-/Kleinschreibung) muss am Anfang stehen. Danach folgt eines von diesen: Ende der Zeile, ein Satzzeichen (`. , ; : !`), ein Gedankenstrich (–, — oder ein Bindestrich mit Leerzeichen oder Zeilenende dahinter) oder eine öffnende Klammer.
- `parseActionLine` nutzt `NO_ACTION` und liefert dann `null`. Alles andere geht wie bisher durch `shorten`.
- **Bleibt eine Aktion:** „Keine Datenbank-URL hinterlegt – bitte eintragen“, „Nichtsdestotrotz …“, „Keine-Ahnung-Modus …“. Dort folgt direkt ein Wort oder ein Bindestrich ohne Leerzeichen.
- **Regressionstest** (`src/runner/action-todo.test.ts`, „AKTION: „keine“ mit Begründung ist keine offene Aktion“): 13 Fälle mit `null`, darunter `keine –`, `keine (…)`, `Keine:`, `nichts –`, `n/a (…)`, `- (…)` und die Form in Anführungszeichen. Dazu 3 Fälle, die eine Aktion bleiben, darunter der Fall „Keine Datenbank-URL“.

## Geänderte Dateien

- `src/runner/action-todo.ts`
- `src/runner/action-todo.test.ts`

Keine Datei unter `docs/` beschrieb die AKTION-Zeile, deshalb gab es dort nichts anzupassen.

## Worauf zu achten ist

- **Test nicht gelaufen:** Der Wächter sperrte `tsx --test` für den Entwickler. Der Tester soll nur `src/runner/action-todo.test.ts` und `npm run typecheck` starten, nicht die ganze Suite und ohne `--experimental-test-coverage`. Fremde Backend-Fehler (`secret-holdback`, `report-copies`, `sprint-reviews-live`) haben mit diesem Auftrag nichts zu tun.
- **Nebenwirkung, gewollt:** Steht bei einem Auftrag schon eine Aktion „keine – …“, wird sie bei der nächsten Analyse über `setActionTodo(…, null)` gelöscht und der Sprintbericht wird neu erzeugt.
- **Ort:** Der Fix sitzt in `parseActionLine`, nicht in den im Auftrag genannten Zeilen 51–56. Dort stand der Code zum Zeitpunkt des Auftrags.

## Sprint 23

| Auftrag | Zustand | Details |
| --- | --- | --- |
| 017be1a1 Analyse setzt „keine – …“ als offene Aktion | umgesetzt, Test wartet auf Tester | Regex `NO_ACTION`, 16 Testfälle |

## Anfrage / TODO

- Tester: `src/runner/action-todo.test.ts` und `npm run typecheck` ausführen und das Ergebnis bestätigen.
