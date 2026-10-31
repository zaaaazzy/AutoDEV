# Tokens und Kosten eines unterbrochenen Schritts zählen fürs Budget

Auftrag e6b27b94 (Bugfix, Sprint 28). Aus der Gesamtprüfung vom 21.10.2026 (Bereich: runner, Schwere: niedrig).

## Problem

Gemeldet war: Bei Nutzungslimit, Shutdown und Ordnerausfall schreibe das UPDATE auf `agent_run_steps` nur Status, Exit-Code, Dauer und Ausgabe. Tokens und Kosten eines Schritts, der eine Stunde gearbeitet hat und dann mit „hit your session limit“ endet, fehlten dann im Tages-, Sprint- und Auftragsbudget.

## Befund

Der Fehler ist im Code bereits behoben. Alle drei Zweige rufen `markInterrupted` auf (`src/runner/runner-steps.ts:112-123`). Das UPDATE schreibt `tokens = result.tokens ?? 0` und `cost_usd = result.costUsd ?? 0` zusammen mit `interrupted = TRUE`. Es fehlte nur ein Regressionstest, der die Werte prüft.

## Umsetzung

Am Produktivcode wurde nichts geändert. Ergänzt wurden Tests:

- **Nutzungslimit** (`src/runner/runner.test.ts`, bestehender Test erweitert): Der Executor meldet das Limit mit `tokens: 1234` und `costUsd: 0.5`. Geprüft werden `step.values[4] === 1234` und `step.values[5] === 0.5`. Vorher wurde nur der SQL-Text geprüft. Der Test, dass kein Bug-Bericht entsteht, bleibt grün.
- **Ordnerausfall** (`src/runner/runner.test.ts`, neu): Der Projektordner ist ein temporäres Verzeichnis, das der Executor mitten im Schritt löscht. Geprüft werden die Meldung „erneut eingeplant“, die Werte 777 und 0.25 im UPDATE und dass kein Bug-Bericht entsteht.
- **Shutdown** (`src/runner/runner-shutdown.test.ts`, neue Datei): Geprüft werden die Meldung „Der Worker wurde beendet“, die Werte 4321 und 1.75 und dass kein Bug-Bericht entsteht.

## Geänderte Dateien

- `src/runner/runner.test.ts`
- `src/runner/runner-shutdown.test.ts` (neu)

Datenbank, API und Oberfläche sind unverändert.

## Worauf achten

- Der Shutdown-Test liegt in einer eigenen Datei, weil `beginShutdown()` den ganzen Prozess beendet und sonst andere Tests stören würde. Nicht in `runner.test.ts` zurückverschieben.
- Neue Abbruchzweige müssen `markInterrupted` nutzen und kein eigenes UPDATE schreiben. Sonst gehen Tokens und Kosten wieder verloren.
- Die Tests hängen an keiner festen Uhrzeit oder Zeitzone.
- Die Wiederholung nach dem ersten Versuch rechnet Tokens und Kosten weiterhin zusammen. Das Ende eines normalen Schritts speichert sie ebenfalls.

## Sprint

| Auftrag | Titel | Art | Sprint | Zustand |
|---|---|---|---|---|
| e6b27b94 | Tokens und Kosten eines unterbrochenen Schritts zählen nicht fürs Budget | Bugfix | Sprint 28 | Fix war schon im Code; Regressionstests ergänzt (Entwickler), dokumentiert; Tests in diesem Schritt nicht neu ausgeführt |

## Anfrage / TODO

- Anfrage: Gesamtprüfung vom 21.10.2026 (runner). Akzeptanzkriterien: Schritt mit Nutzungslimit speichert Tokens und Kosten; Regressionstest in `src/runner/runner.test.ts`. Beides erfüllt.
- Offen: nichts für diesen Auftrag. Der offene Bug „CI: `npm run test:unit` schlägt fehl“ ist davon unabhängig.
