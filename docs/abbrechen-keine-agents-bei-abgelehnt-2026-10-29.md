# Nach „Abbrechen“ laufen keine Agents „Bei abgelehnt“ mehr

Auftrag f8dd63b7 (Bugfix, Sprint 28). Aus der Gesamtprüfung vom 21.10.2026 (Bereich: runner, Schwere: niedrig).

## Problem

Ein vom Benutzer abgebrochener Schritt („Abbrechen“ am laufenden Agent oder Sprint-Abbruch, `cancel_requested`) lieferte `{ passed: false, interrupted: false }`. `runWorkItem` behandelte das wie ein normales Scheitern und startete die Agents der Phase `on_rejected`. Diese verbrauchten Tokens und konnten Dateien ändern.

## Umsetzung

- `src/runner/runner-steps.ts`: `StepOutcome` hat das neue Feld `cancelled?: boolean`. `runStep` setzt es bei Abbruch, sowohl im Beobachter-Zweig als auch am normalen Ende. `interrupted` bleibt `false`, der Auftrag wird also nicht neu eingeplant.
- `src/runner/runner.ts`: `runWorkItem` merkt sich `cancelled`, setzt `passed = false` und verlässt die Schleife (keine Nachbesserung, kein nächster Agent). Die Beobachter von „Bei abgelehnt“/„Bei abgeschlossen“ werden bei `cancelled` übersprungen (wie bei Unterbrechung und Kostenbremse). Wird ein Beobachter selbst abgebrochen, starten die übrigen ebenfalls nicht.
- Es entsteht kein Bug-Bericht für den Abbruch.

## Tests

- `src/runner/runner.test.ts` (am Ende): Abbruch über `cancel_requested` → kein Schritt der Phase `on_rejected`; Sprint-Abbruch während des Laufs → ebenfalls keiner; Gegenprobe: Scheitert ein Schritt ohne Abbruch, läuft „Bei abgelehnt“ weiterhin.
- `src/runner/runner-steps.test.ts`: Drei bestehende Tests, die das ganze Ergebnis vergleichen, kennen das neue Feld; der Abbruch-Test erwartet `cancelled: true`.
- Die Tests wurden in diesem Schritt nicht neu ausgeführt.

## Geänderte Dateien

- `src/runner/runner-steps.ts`
- `src/runner/runner.ts`
- `src/runner/runner.test.ts`
- `src/runner/runner-steps.test.ts`
- `docs/workflows.md` (Absatz zu „Bei abgelehnt/abgeschlossen“)
- `docs/benutzerhandbuch-agenten-per-drag-and-drop-zwischen-phasen.md` (Hinweis bei den Phasen)

Datenbank, API und Oberfläche sind unverändert.

## Worauf achten

- Neue Abbruchwege müssen `cancelled` melden, nicht `interrupted`. `interrupted` plant den Auftrag neu ein.
- Neue Schleifen oder Phasen im Runner müssen `cancelled` ebenfalls beachten.
- In `docs/benutzerhandbuch-budget-pruefung-und-job-sperre.md` fehlt noch eine Zeile zu `cancelled`, falls dort alle Haltefälle aufgezählt werden sollen (Hinweis des Entwicklers, nicht umgesetzt).

## Sprint

| Auftrag | Titel | Art | Sprint | Zustand |
|---|---|---|---|---|
| f8dd63b7 | Nach „Abbrechen“ laufen noch die Agents „Bei abgelehnt“ | Bugfix | Sprint 28 | Umgesetzt und dokumentiert (Entwickler); Tests in diesem Schritt nicht neu ausgeführt |

## Anfrage / TODO

- Anfrage: Gesamtprüfung vom 21.10.2026 (runner). Akzeptanzkriterien: Nach einem Benutzerabbruch startet kein weiterer Agent des Auftrags; Regressionstest in `src/runner/runner.test.ts`. Beides umgesetzt.
- Offen: optional die Zeile zu `cancelled` im Benutzerhandbuch zur Budget-Prüfung. Die offenen Bugs (Tokenstand im Dashboard, CI `test:unit`) sind unabhängig.
