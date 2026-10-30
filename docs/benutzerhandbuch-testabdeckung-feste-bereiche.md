# Testabdeckung: feste Bereiche und Verlauf

Dieses Kapitel beschreibt die Testabdeckung in AIdeation: welche Bereiche es gibt, welche Werte Pflicht sind, wo du den Verlauf siehst und was abgelehnt wird.

## Was sich geändert hat

- Testabdeckung wird nur noch für sechs feste Bereiche gespeichert und angezeigt:

  | Bereich | Bedeutung |
  | --- | --- |
  | `backend` | Server- und API-Code |
  | `frontend` | Oberfläche (Angular) |
  | `scripts` | Skripte und Werkzeuge |
  | `e2e` | Ende-zu-Ende-Tests im Browser |
  | `gesamt` | gesamtes Projekt |
  | `auftrag` | nur der vom Auftrag geänderte Code |

- Jede Meldung braucht für jeden gemeldeten Bereich einen **Zeilenwert** und einen **Zweigwert** (Zahl von 0 bis 100) sowie **mindestens einen Testfall** in diesem Bereich.
- Die Statistik zeigt je Bereich einen **Verlauf** über alle Messungen.
- Die Dashboard-Kachel zeigt weiterhin den **neuesten Bericht** des Projekts.
- Alte Einträge mit anderen Schreibweisen (z. B. „Backend (src)“ oder „Angular“) wurden einmalig auf die festen Namen umgestellt. Einträge, die sich keinem Bereich zuordnen lassen, bleiben unverändert gespeichert, erscheinen aber nicht im Verlauf.

## Wann eine Meldung angenommen wird

Eine Meldung wird vollständig geprüft und nur dann gespeichert, wenn alle Bedingungen gelten:

1. Jeder Bereich ist einer der sechs festen Namen. Groß- und Kleinschreibung und Leerzeichen am Rand spielen keine Rolle. Unbekannte Namen werden **nicht** stillschweigend angelegt.
2. Zeilenwert und Zweigwert sind Zahlen von 0 bis 100. Fehlt einer der beiden, ist die Meldung ungültig.
3. Jeder gemeldete Bereich hat mindestens einen Testfall (Summe aus Unit-, Komponenten-, Integrations- und E2E-Tests größer als 0).
4. Ein Bereich darf in einer Meldung nur einmal vorkommen.

Eine ungültige Meldung wird als Ganzes abgelehnt. Es wird nichts ergänzt oder umgedeutet, und es wird nichts gespeichert.

Was du davon siehst:

- **Agent-Lauf (Tester):** Ist der `@@COVERAGE`-Block ungültig, wird er verworfen. Im Schrittverlauf steht der Grund, zum Beispiel „Bereich frontend: Zweigwert (branches) fehlt oder liegt nicht zwischen 0 und 100.“. Hat AIdeation den Bereich selbst gemessen, bleibt diese Messung erhalten.
- **Schreibweg über die Schnittstelle:** Eine ungültige Meldung antwortet mit Status 400 und einer Liste der Gründe. Nichts wird gespeichert.

## Statistik: Testabdeckung im Verlauf

**Ort:** Statistik, Abschnitt „Testabdeckung im Verlauf“ (unter den übrigen Statistiken).

**Anzeige:**

- Je Bereich eine Karte mit dem Namen als Überschrift.
- Eine Grafik mit Zeilen-Verlauf (durchgezogene Linie, Kreise), Zweig-Verlauf (Linie mit Quadraten) und einer gestrichelten Linie für das Ziel von 75 % Zeilenabdeckung.
- Unter der Grafik ein aufklappbarer Bereich **„Messungen als Tabelle“** mit den Spalten Datum, Zeilen %, Zweige %, Tests gesamt. Die Messungen sind nach Datum aufsteigend sortiert.
- Fahre mit der Maus über einen Punkt, um Datum, Zeilen %, Zweige % und die Anzahl der Tests zu sehen.

**Bedingungen und Sonderfälle:**

- **Lücke statt 0 %:** Hat eine alte Messung für einen Wert keine Zahl, bleibt der Punkt weg. In der Tabelle steht dann „–“. Eine fehlende Messung wird nie als 0 % gezeichnet.
- **Bereich ohne Messung:** Gibt es für einen Bereich keine Messung, steht dort „Noch keine Messung für diesen Bereich.“
- **Noch keine Messung im Projekt:** Gibt es für kein Bereich Messungen, steht dort „Noch keine Testabdeckung gemessen.“
- **Alte Einträge ohne Zuordnung:** Sie werden in der Statistik nicht angezeigt, bleiben aber in der Datenbank erhalten.
- **Fehler beim Laden:** Schlägt das Laden fehl, steht dort „Verlauf der Testabdeckung konnte nicht geladen werden.“
- Der Verlauf zeigt höchstens die letzten 200 Berichte je Projekt.

<!-- Printscreen 1: Statistik, Abschnitt „Testabdeckung im Verlauf“ mit mindestens zwei Bereichen und Messungen. Sichtbar: Überschrift, Legende „Zeilen % / Zweige % / Ziel 75 %“, Karten je Bereich, Tabelle aufgeklappt. -->
> **Printscreen fehlt:** Diese Ansicht ist in diesem Lauf nicht aufgenommen, weil kein Browser installiert ist und die App nicht läuft. Aufnehmen lässt sie sich auf einem Host mit laufender App und Datenbank.

## Dashboard-Kachel „Testabdeckung“

**Ort:** Dashboard.

**Anzeige:** Die Kachel zeigt den neuesten Bericht des aktuellen Projekts mit allen Bereichen, die dieser Bericht enthält. Je Bereich stehen die Spalten Unit-Tests, Komponententests, Integrationstests, E2E-Tests und Gesamt. Darunter folgen die Abdeckungswerte Zeilen, Anweisungen, Zweige und Funktionen. Fehlgeschlagene Tests stehen als Hinweis unter dem Bereichsnamen. Jede Spalte hat einen Tooltip mit ihrer Erklärung.

**Bedingungen:**

- Gibt es noch keinen Bericht, zeigt die Kachel keine Werte.
- Die Kachel ändert sich erst, wenn ein neuer Bericht gespeichert wurde. Der Verlauf steht nur in der Statistik.

<!-- Printscreen 2: Dashboard, Kachel „Testabdeckung“ mit einem Bericht (Tabelle mit den festen Bereichsnamen). -->
> **Printscreen fehlt:** Siehe oben, nicht aufgenommen.

## Abnahme: fehlende Messung

Früher galt „Abdeckung nicht messbar“ im Abnahmeschritt immer als erfüllt. Das ist geändert:

- Ein Punkt zur Abdeckung, den der Tester als „nicht messbar“ meldet, gilt nur dann als erfüllt, wenn **trotzdem ein gültiger Bericht gespeichert wurde**, in der Regel durch die Messung durch AIdeation.
- Gibt es keinen gültigen Bericht, bleibt der Punkt offen.
- Rote Tests oder Kriterien ohne Test bleiben immer ein Ablehnungsgrund.

Das Wort „null“ zählt für die Abnahme nicht mehr als Messung.

## Für Entwickler und Schreibwege

### Schreibweg (HTTP)

- **Endpunkt:** `POST /projects/:slug/coverage`
- **Recht:** Rolle „Agents ausführen“ (`run`) für das Projekt.
- **Antwort:** Status 201 mit der ID des Berichts, oder Status 400 mit `message` und `errors` (eine Zeile je Grund).
- Der Endpunkt nutzt denselben Validator wie der Runner.

### Lesen

- `GET /projects/:slug/coverage`: neuester Bericht (Dashboard).
- `GET /projects/:slug/coverage/trend`: Verlauf je fester Bereich, nach Datum aufsteigend. Fehlende Werte kommen als `null` zurück; die Oberfläche zeichnet sie als Lücke.

### Bereichsnamen ändern oder ergänzen

- Die Liste steht genau einmal in `COVERAGE_AREAS` (`src/runner/coverage.ts`). Ein neuer Bereich braucht eine Codeänderung. Das ist so gewollt.
- Bekannte Schreibweisen stehen in `COVERAGE_AREA_ALIASES` (gleiche Datei). Eine neue Schreibweise kommt dort hinein und zusätzlich per neuer Migration in die Tabelle `coverage_area_aliases`. Die Migration 20 nicht ändern.

## Fehlerbehebung

| Meldung oder Zustand | Ursache | Was tun |
| --- | --- | --- |
| „Bereich „xyz“ unbekannt (erlaubt: backend, …)“ | Der Name ist nicht in der festen Liste und nicht bekannt. | Tester-Prompt und Messung nutzen die festen Namen. Eine neue Schreibweise nur über Zuordnung ergänzen. |
| „Zeilenwert (lines) fehlt oder liegt nicht zwischen 0 und 100“ | Der Zeilenwert fehlt oder ist außerhalb von 0 bis 100. | Den Wert messen und melden. Ein Bereich ohne Messung weglassen. |
| „0 Testfälle“ | Der Bereich hat keine Tests. | Den Bereich nicht melden, oder Tests ergänzen. |
| Kachel leer, Verlauf zeigt nur alte Werte | Es gibt noch keinen neuen Bericht. | Einen Lauf mit Messung abwarten. |
| Bereich fehlt im Verlauf, obwohl alte Daten existieren | Der Altbestand hat keine Zuordnung und wird ausgeblendet. | Nichts zu tun. Die Daten bleiben erhalten. |

## Grenzen

- Die Liste ist fest. Neue Bereiche gibt es nur mit einer Codeänderung.
- Der Verlauf zeigt höchstens die letzten 200 Messungen je Projekt.
- Altbestand wird nicht gelöscht. Nicht zuordenbare Einträge bleiben unverändert in der Datenbank.
- Die 75-%-Schwelle der Definition of Done ist unverändert.

## Offene Entscheidungen

Diese Punkte sind im Code noch nicht eindeutig entschieden:

1. **Teilmeldungen:** Die Anforderung verlangt Werte für alle sechs Bereiche. Der Validator prüft aber nur die Bereiche, die gemeldet werden. Heute werden Berichte mit nur einem gemessenen Bereich gespeichert. Entscheidung nötig: Pflicht für alle sechs, oder nur gemessene Bereiche.
2. **Migrationsnummer:** Die Migration heißt Version 20. Version 19 ist über `RESERVED_VERSIONS` als reserviert eingetragen. Gibt es keinen parallelen Schritt 19, sollte auf 19 umnummeriert und die Reservierung entfernt werden.
3. **Oberflächentest:** `full-ui.check.ts` ist für die neue Statistik-Ansicht noch nicht angepasst und nicht geprüft.

## Nicht geprüft

- Lint, Typecheck und Unit-Tests habe ich in diesem Lauf nicht ausgeführt. Die Aussagen dieses Kapitels stammen aus dem Code (`src/runner/coverage.ts`, `src/api/coverage.ts`, `src/runner/acceptance.ts`, `frontend/src/app/features/stats/coverage-trend.component.ts`).
- Die Oberfläche habe ich nicht gesehen.
- Printscreens fehlen (siehe oben).
