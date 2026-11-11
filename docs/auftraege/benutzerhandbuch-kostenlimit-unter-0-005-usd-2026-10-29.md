# Kostenlimits: Mindestbetrag 0,01 USD und Speichern in einer Transaktion

Auftrag 6eeb7dae (Bugfix, Schwere niedrig). Bisher führte ein Kostenlimit unter 0,005 USD zu einem Serverfehler (500), und ein Teil der Limits blieb gespeichert, während der Rest fehlschlug. Jetzt wird das Limit beim Eintippen geprüft: Zu kleine Beträge werden mit einer Meldung abgelehnt, und ein Speichern ist immer ganz oder gar nicht.

## Was sich für dich ändert

Im Bereich **Einstellungen → Budget** gibt es die Spalte **Kosten (USD)** für die Zeiträume Tag, Sprint und Auftrag. Dort gilt jetzt:

- **Mindestbetrag 0,01 USD.** Kleinere Beträge werden nicht gespeichert.
- **Runden auf Cent.** Beträge werden auf 2 Nachkommastellen gerundet, wie der Wert in der Datenbank gespeichert wird. Beispiele:
  - `0,004` → wird abgelehnt (würde zu 0,00).
  - `0,005` → wird zu `0,01` gespeichert.
  - `2,499` → wird zu `2,50` gespeichert.
- **Leer lassen** heißt unbegrenzt (keine Kostenprüfung für diesen Zeitraum).
- **Alles oder nichts.** Wird eine Eingabe abgelehnt, bleibt auch das Tageslimit beim alten Wert. Vorher blieb das Tageslimit gespeichert, obwohl das Sprintlimit fehlschlug.

Die Token-Spalte ist nicht betroffen. Sie akzeptiert weiter jede positive Zahl.

## Fehlermeldung

Ist ein Kostenlimit kleiner als 0,01 USD, erscheint oben auf der Seite:

> Kostenlimit: mindestens 0,01 USD (oder leer lassen für unbegrenzt).

Das Speichern bricht dann ab. Nichts wird geändert, auch nicht die anderen Zeiträume und Felder derselben Eingabe.

## Beispiel

Eingabe: Tageslimit `5` USD, Sprintlimit `0,004` USD.

1. Du klickst auf **Budget speichern**.
2. Der Server lehnt die Anfrage mit 400 ab. Die Meldung oben nennt den Mindestbetrag.
3. Das Tageslimit ist nicht gespeichert. Der vorherige Stand bleibt sichtbar, bis du eine gültige Eingabe speicherst.

Lösung: Im Sprintfeld `0,01` eingeben oder das Feld leer lassen.

## Hinweise

- Das Eingabefeld hat `min="0.01"`. Ob der Browser deshalb schon vor dem Absenden warnt, ist nicht geprüft. Verbindlich ist die Prüfung des Servers, die immer die Meldung oben zeigt.
- Die Anzeige in CHF ändert nichts an der Speicherung: Gespeichert werden immer USD-Beträge.
- Der Speichervorgang umfasst alle Teile des Formulars (Limits, Währung, Routing-Regeln, lokales Modell, starker Befehl). Scheitert einer davon, wird der ganze Vorgang zurückgenommen.

## Offen

- **Printscreens fehlen.** Die App lief für den Agenten nicht (keine Datenbank, Docker-Befehle gesperrt). Nötig sind:
  1. Einstellungen → Budget mit der Meldung „Kostenlimit: mindestens 0,01 USD …“ nach Eingabe von `0,004`.
  2. Dasselbe Feld mit `0,01` (gespeichert, kein Fehler).
  3. Die Spalte „Kosten (USD)“ mit leerem Feld (unbegrenzt).
- **Tests nicht ausgeführt.** Die neuen Tests in `src/api/budget.test.ts` sind noch nie gelaufen. Nötig: `npm run test:unit` (mindestens `src/api/budget.test.ts`), `npm run typecheck`, `npm run lint` und `npm run format:check`.
- **Oberfläche nicht im Browser geprüft.** Die Beschreibung stammt aus dem Code (`budget-settings.component.ts`, `project-store.ts`).
- **Zeilenangabe im Auftrag veraltet.** `src/db/schema.ts:1034` gehört inzwischen zu `routing_rules`. Die Prüfung steht in `src/api/budget.ts`.

## Verweise

- `docs/laufzeit.md`, Abschnitt „Budget und Modell-Routing“: Kurzfassung für den Betrieb.
- `docs/kostenlimit-unter-0-005-usd-500-und-halb-gespeicherte-budgets-2026-10-29.md`: Dokumentation für Entwickler zu diesem Auftrag.
