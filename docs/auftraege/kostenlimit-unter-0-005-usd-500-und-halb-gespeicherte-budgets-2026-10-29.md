# Kostenlimit unter 0,005 USD führt zu 500 und halb gespeicherten Budgets

Auftrag 6eeb7dae (Bugfix, Schwere niedrig, Fund der Gesamtprüfung vom 21.10.2026, Bereich Backend).

## Problem

`limitNumber` ließ jede Zahl > 0 zu. Die Spalte `budgets.max_cost_usd` ist `NUMERIC(10, 2)` mit `CHECK (max_cost_usd > 0)`. Ein Wert wie 0.004 wird beim Speichern zu 0.00 gerundet und verletzt den CHECK, die Antwort war ein 500. Dazu schrieb `saveBudget` ohne Transaktion Zeitraum für Zeitraum: Bei `PUT /api/projects/x/budget` mit Tageslimit 5 und Sprintlimit 0.004 blieb das Tageslimit gespeichert, das Sprintlimit scheiterte.

## Umsetzung

`src/api/budget.ts`:

- **Neue Hilfe `costNumber`:** nutzt `limitNumber`, rundet auf 2 Nachkommastellen und liefert `'too-small'`, wenn das Ergebnis unter 0,01 liegt. Token-Limits laufen weiter über `limitNumber` und bleiben unverändert.
- **`parseBudgetInput`:** nimmt `costNumber` für `maxCostUsd`. Bei `'too-small'` kommt die Meldung „Kostenlimit: mindestens 0,01 USD (oder leer lassen für unbegrenzt).“ und damit ein 400. Weil die Prüfung vor jedem Schreiben passiert, wird dabei nichts gespeichert.
- **`saveBudget`:** läuft komplett in `withTransaction` (`src/db/transaction.js`), alle Queries gehen über `client` statt `pool`. Scheitert ein Schritt (Limits, Währung, Routing-Regeln, lokales Modell, starker Befehl), wird alles zurückgerollt. Muster wie in `users.ts` und `development.ts`.

`docs/laufzeit.md`: Absatz zum Mindestbetrag 0,01 USD und zum Speichern in einer Transaktion (Abschnitt Budget).

## Tests

`src/api/budget.test.ts`:

1. Regressionstest für `parseBudgetInput`: 0.004 ergibt eine Fehlermeldung; Tageslimit 5 zusammen mit Sprintlimit 0.004 ergibt eine Fehlermeldung; 0.005 wird auf 0.01 gerundet; 0.01 ist gültig; `'2.499'` wird zu 2.5.
2. Fehlgeschlagenes Speichern: `BEGIN` wird gesendet, dann `ROLLBACK`, kein `COMMIT`.
3. Ursprüngliches Szenario über die Route: 400 mit Meldung, keine einzige Schreib-Query.
4. Der bestehende Speichertest bekam im Mock-Pool ein `connect()`.

**Nicht ausgeführt:** Weder der Entwickler noch die Dokumentation durften `tsx` oder Prettier starten. Offen für den Tester: `npm run test:unit` (mindestens `src/api/budget.test.ts`), `npm run typecheck`, `npm run lint`, `npm run format:check`. Die Zeilenlänge (120 Zeichen laut `.prettierrc.json`) wurde nur von Hand geprüft.

## Geänderte Dateien

- `src/api/budget.ts`
- `src/api/budget.test.ts`
- `docs/laufzeit.md`

Datenbankschema und Oberfläche sind unverändert; das Eingabefeld in den Einstellungen hat schon `min="0.01"`.

## Worauf zu achten ist

- **Rundung:** 0.005 und mehr wird auf 0,01 aufgerundet, alles darunter abgelehnt. Gespeichert wird immer der gerundete Wert, die API gibt ihn beim nächsten Lesen so zurück.
- **Mock-Pools in Tests:** Wer `saveBudget` testet, braucht einen Pool mit `connect()` (siehe `BEGIN`/`COMMIT`-Muster in `budget.test.ts`). `app.test.ts` filtert `BEGIN`, `COMMIT` und `ROLLBACK` aus den aufgezeichneten Queries, dort ändert sich nichts.
- **Zeilenangabe im Auftrag veraltet:** `src/db/schema.ts:1034` ist inzwischen `routing_rules`; den `CHECK` findet man mit `git grep "max_cost_usd"`.
- **Benutzerhandbuch:** Der Mindestbetrag 0,01 USD und die Fehlermeldung könnten dort ergänzt werden, falls Limits beschrieben sind.
- Die früheren „offenen“ Bug-Einträge (Bug-Wächter, Ausgabenlimit) sind reine Abbrüche durch das Ausgabenlimit der Claude-CLI und haben mit diesem Code nichts zu tun.

## Sprint und Anfrage/TODO

Der Auftrag gehört zum Sprint der Gesamtprüfung-Funde. Zustand nach diesem Schritt: umgesetzt, Tests noch nicht ausgeführt; Abnahme durch den Tester offen. Die Sektionen Sprint und Anfrage/TODO werden in der Anwendung geführt, hier ist nichts zu ändern. TODO: Tester-Lauf (siehe oben).
