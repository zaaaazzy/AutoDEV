# Benutzerhandbuch: Tokens und Kosten eines unterbrochenen Schritts zählen fürs Budget

Gilt ab Sprint 28 (Auftrag e6b27b94, Bugfix). Betrifft Agent-Schritte, die unterbrochen enden, und das Tages-, Sprint- und Auftragsbudget unter Einstellungen → Budget.

## Was sich ändert

Ein Agent-Schritt kann unterbrochen enden, etwa weil das Nutzungslimit des Anbieters erreicht ist, der Worker beendet wird oder der Projektordner verschwindet. Bisher konnte der Verbrauch dieses Schritts in der Datenbank ohne Tokens und Kosten landen. Dann fehlte er im Budget, und die Limits wurden überschritten.

Jetzt gilt: Ein unterbrochener Schritt speichert seine **Tokens und Kosten** genauso wie ein regulär beendeter Schritt. Der Verbrauch zählt damit in allen Budgets, die den Auftrag enthalten.

Eine neue Oberfläche gibt es dafür nicht. Die Änderung wirkt im Hintergrund. Deshalb gibt es hier keine Printscreens (siehe unten).

## Bedingungen

### Welche Fälle gelten als unterbrochen

| Ursache | Was der Schritt meldet | Tokens und Kosten zählen? |
|---|---|---|
| Nutzungslimit des Anbieters („hit your session limit“ oder ähnlich) | Schritt `fehlgeschlagen`, Kennzeichen „unterbrochen“ | Ja |
| Worker wird beendet (Shutdown) | Schritt `fehlgeschlagen`, Kennzeichen „unterbrochen“ | Ja |
| Projektordner fehlt während des Schritts | Schritt `fehlgeschlagen`, Kennzeichen „unterbrochen“ | Ja |
| Budget vor dem zweiten Versuch nicht prüfbar | Schritt `fehlgeschlagen`, Kennzeichen „unterbrochen“ | Ja, die Tokens des ersten Versuchs |

Ein Schritt, der regulär endet, zählt ebenfalls Tokens und Kosten. Dieser Fall ändert sich nicht.

### Wie die Werte gezählt werden

- Tokens und Kosten werden als gemeldet gespeichert. Fehlt eine Angabe des Anbieters, zählt sie als 0.
- Wiederholt der Agent nach einem vorübergehenden Fehler einen Versuch, werden die Werte beider Versuche zusammengezählt. Der erste Versuch geht also nicht verloren.
- Das Budget summiert alle Schritte eines Auftrags. Ob ein Schritt unterbrochen ist, spielt für die Summe keine Rolle.

### Wo der Verbrauch wirkt

| Budget | Zählt der unterbrochene Schritt mit? |
|---|---|
| Tageslimit | Ja |
| Sprintlimit (nur für Aufträge des aktiven Sprints, siehe `docs/benutzerhandbuch-sprintbudget-nur-sprint-auftraege.md`) | Ja, wenn der Auftrag im aktiven Sprint steht |
| Auftragslimit | Ja |
| Rollenlimit | Ja |

## Was du siehst

| Situation | Was passiert |
|---|---|
| Ein Schritt endet wegen des Nutzungslimits, nachdem er lange gearbeitet hat | Sein Verbrauch steigt im Budget. Erreicht das Limit 100 %, startet kein neuer Schritt. Der Auftrag wird `blockiert` mit „Budget erreicht: erhöhen oder warten“. |
| Ein unterbrochener Schritt bringt das Budget auf 80 % | Es kommt die Push-Warnung wie bei jedem anderen Verbrauch. |
| Der Auftrag wird nach der Unterbrechung fortgesetzt | Der Verbrauch des unterbrochenen Schritts bleibt erhalten. Er wird nicht doppelt gezählt. |

## Beispiel

Ein Entwickler-Schritt arbeitet eine Stunde und endet mit „hit your session limit“. Er hat 80 000 Tokens und 1,20 USD verbraucht.

- Das Tageslimit steht danach bei 80 000 Tokens und 1,20 USD, auch wenn der Schritt unterbrochen endete.
- Hat der Auftrag ein Auftragslimit von 100 000 Tokens, steht es nach dem Schritt bei 80 %.
- Vor der Änderung hätten diese 80 000 Tokens im Budget gefehlt.

## Hinweis zur Oberfläche

Die Oberfläche zeigt den Verbrauch unverändert im Budget an. Die Änderung betrifft nur die Zahlen dahinter.

## Printscreens

Keine. Die Änderung hat keine eigene Oberfläche, und die Budgetseite zeigt nach dieser Änderung dieselben Felder wie vorher. Die Zahlen dort ändern sich nur, wenn ein unterbrochener Schritt Verbrauch gemeldet hat. Für einen Printscreen müsste eine laufende App mit Datenbank und Worker einen Schritt mit Nutzungslimit durchlaufen. Das ist für diesen Lauf nicht geschehen.

## Fehlerbehebung

- **Ein unterbrochener Schritt zeigt im Budget keinen Verbrauch.** Prüfe, ob der Schritt tatsächlich Tokens meldet. Meldet der Anbieter keine Angabe, bleibt der Verbrauch 0. Das ist dann kein Fehler dieser Änderung.
- **Das Budget steht nach einer Unterbrechung höher als erwartet.** Das ist beabsichtigt. Der Verbrauch des Versuchs wurde tatsächlich verbraucht.
- **Der Auftrag bleibt `blockiert`.** Erhöhe das Limit unter Einstellungen → Budget oder warte bis zum Zurücksetzen des Zeitraums.

## Für Entwickler

Alle Abbruchzweige schreiben über `markInterrupted` in `src/runner/runner-steps.ts`. Dort stehen `tokens` und `cost_usd` im selben UPDATE. Ein neuer Abbruchzweig soll diese Funktion nutzen. Die Regressionstests liegen in `src/runner/runner.test.ts` und `src/runner/runner-shutdown.test.ts`. Technische Details stehen in `docs/tokens-kosten-unterbrochener-schritt-2026-10-29.md`.

## Offen

- Die Tests wurden in diesem Schritt nicht neu ausgeführt. Der Stand stammt aus dem Entwickler- und Dokumentierer-Lauf.
- Printscreens fehlen (siehe oben).
