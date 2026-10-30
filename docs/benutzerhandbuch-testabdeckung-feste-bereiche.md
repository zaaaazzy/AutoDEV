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

**Für den Tester (Agent):** Der Tester-Auftrag nennt die sechs Namen und verbietet `null`-Werte sowie Bereiche ohne Tests. Ein nicht messbarer Bereich wird weggelassen, nicht mit `null` gemeldet. Lässt sich die Abdeckung nicht messen (z. B. Werkzeug fehlt oder der Wächter sperrt den Befehl), misst AIdeation nach dem Schritt selbst. Ohne gültige Messung bleibt der Abnahmepunkt offen (siehe Abschnitt „Abnahme: fehlende Messung“).

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
- **Kein Projekt:** Ist kein Projekt aktiv, steht dort „Kein Projekt ausgewählt.“ Es wird dann keine Abfrage gestartet.
- **Laden:** Während der Abfrage steht dort „Verlauf wird geladen …“.
- **Fehler beim Laden:** Schlägt das Laden fehl, steht dort „Verlauf der Testabdeckung konnte nicht geladen werden.“
- Der Verlauf zeigt höchstens die letzten 200 Berichte je Projekt.

<!-- Printscreen 1: Statistik, Abschnitt „Testabdeckung im Verlauf“ mit mindestens zwei Bereichen und Messungen. Sichtbar: Überschrift, Legende „Zeilen % / Zweige % / Ziel 75 %“, Karten je Bereich, Tabelle aufgeklappt. -->
> **Printscreen fehlt:** Diese Ansicht ist in diesem Lauf nicht aufgenommen, weil kein Browser installiert ist und die App nicht läuft. Aufnehmen lässt sie sich auf einem Host mit laufender App und Datenbank.

## Dashboard-Kachel „Testabdeckung“

**Ort:** Dashboard.

**Anzeige:** Die Kachel zeigt den neuesten Bericht des aktuellen Projekts mit allen Bereichen, die dieser Bericht enthält. Je Bereich stehen die Spalten Unit-Tests, Komponententests, Integrationstests, E2E-Tests und Gesamt (Summe der vier Testarten). Darunter folgen die Abdeckungswerte Zeilen, Anweisungen, Zweige und Funktionen. Fehlgeschlagene Tests stehen als Hinweis „N fehlgeschlagen“ unter dem Bereichsnamen. Die vier Testart-Spalten haben einen Tooltip mit ihrer Erklärung.

**Summenzeile:** Hat der Bericht mindestens zwei Bereiche und keinen Bereich „gesamt“, zeigt die Kachel zusätzlich eine Zeile „Gesamt“. Die Testzahlen sind dort Summen über alle Bereiche. Die Prozentwerte sind der Mittelwert der gemeldeten Werte, kein gewichteter Wert. Enthält der Bericht selbst einen Bereich „gesamt“, entfällt die gerechnete Summenzeile, und die gemeldete Zeile steht in der Tabelle.

**Farben der Prozentwerte:** Ab 75 % grün, ab 50 % gelb, darunter rot. Fehlt ein Wert, steht er ohne Farbe.

**Bedingungen:**

- Gibt es noch keinen Bericht, zeigt die Kachel keine Werte.
- Die Kachel ändert sich erst, wenn ein neuer Bericht gespeichert wurde. Der Verlauf steht nur in der Statistik.
- Die Kachel filtert nicht nach festen Namen. Gehört ein Altbestand ohne Zuordnung zum neuesten Bericht, steht er mit seinem alten Namen in der Kachel, auch wenn er in der Statistik fehlt. Die Abfrage ist `GET /projects/:slug/coverage` (siehe unten).

<!-- Printscreen 2: Dashboard, Kachel „Testabdeckung“ mit einem Bericht (Tabelle mit den festen Bereichsnamen). -->
> **Printscreen fehlt:** Siehe oben, nicht aufgenommen.

## Abnahme: fehlende Messung

Früher galt „Abdeckung nicht messbar“ im Abnahmeschritt immer als erfüllt. Das ist geändert:

Ein offener Punkt zur Abdeckung im Definition-of-Done-Abschnitt gilt nur dann als erfüllt, wenn **alle** Bedingungen zutreffen:

1. Alle Akzeptanzkriterien sind als erfüllt belegt.
2. Der Hinweis des Testers zu diesem Punkt nennt die Abdeckung („abdeckung“ oder „coverage“) und zugleich, dass sie nicht gemessen werden konnte. Erkannt werden Formulierungen wie „nicht gemessen“, „nicht ermittelt“, „blockiert“, „gesperrt“, „Wächter“ oder „Freigabe“.
3. Der Hinweis nennt keine echten Lücken. Rote oder fehlgeschlagene Tests, „ungetestet“ und „ohne Test“ bleiben immer ein Ablehnungsgrund.
4. Es gibt trotzdem einen **gültigen, gespeicherten Bericht**, in der Regel durch die Messung durch AIdeation.

Erfüllt der Punkt diese Bedingungen, steht im Hinweis zusätzlich „(Abdeckung misst AIdeation selbst)“. Fehlt ein gültiger Bericht, bleibt der Punkt offen. Eine Meldung „null“ oder ein Hinweis allein zählt nie als Messung.

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
- Bekannte Schreibweisen stehen in `COVERAGE_AREA_ALIASES` (gleiche Datei). Eine neue Schreibweise kommt dort hinein und zusätzlich per neuer Migration in die Tabelle `coverage_area_aliases`. Die Migration 22 nicht ändern.

## Fehlerbehebung

| Meldung oder Zustand | Ursache | Was tun |
| --- | --- | --- |
| „Bereich „xyz“ unbekannt (erlaubt: backend, …)“ | Der Name ist nicht in der festen Liste und nicht bekannt. | Tester-Prompt und Messung nutzen die festen Namen. Eine neue Schreibweise nur über Zuordnung ergänzen. |
| „Zeilenwert (lines) fehlt oder liegt nicht zwischen 0 und 100“ | Der Zeilenwert fehlt oder ist außerhalb von 0 bis 100. | Den Wert messen und melden. Ein Bereich ohne Messung weglassen. |
| „0 Testfälle“ | Der Bereich hat keine Tests. | Den Bereich nicht melden, oder Tests ergänzen. |
| „Kein gültiges JSON.“ im Schrittverlauf | Der `@@COVERAGE`-Block ist syntaktisch kaputt (z. B. ein Komma zu viel). | Den Block in einer Zeile neu melden. Ein ungültiger Block wird ganz verworfen; eine eigene Messung von AIdeation bleibt erhalten. |
| Zeilen- oder Zweigwert „fehlt“, obwohl ein Wert im Block steht | Der Wert ist `null` oder außerhalb von 0 bis 100 (`null` ist nicht erlaubt). | Den Bereich ohne Messung weglassen oder den Wert als Zahl von 0 bis 100 melden. |
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
2. **Migrationsnummer (entschieden):** Die Migration heißt Version 22, weil sprint-30 die Versionen 19 bis 21 belegt. Die Reservierung `RESERVED_VERSIONS` ist entfallen.
3. **Oberflächentest:** `full-ui.check.ts` prüft die neue Statistik-Ansicht (geladen, kein Ladefehler, kein Filterhinweis im Leertext). Der Lauf selbst ist noch nicht bestätigt, weil die Umgebung keinen Browser hat.
4. **Testlauf:** Typecheck und Tests konnten in der Agent-Umgebung nicht laufen (`tsc`/`tsx` nicht gefunden, npm-Cache nicht beschreibbar). Vor dem Mergen `npm run typecheck` und `npm test` in einer Umgebung mit installierten Abhängigkeiten ausführen.
5. **Ladezustand ohne Projekt (im Code geprüft, nicht im Browser gesehen):** Ohne aktives Projekt zeigt die Ansicht „Kein Projekt ausgewählt.“ und lädt nichts.

## Nicht geprüft

- Lint, Typecheck und Unit-Tests habe ich in diesem Lauf nicht ausgeführt. Die Aussagen dieses Kapitels stammen aus dem Code (`src/runner/coverage.ts`, `src/api/coverage.ts`, `src/runner/acceptance.ts`, `frontend/src/app/features/stats/coverage-trend.component.ts`).
- Die Oberfläche habe ich nicht gesehen.
- Printscreens fehlen (siehe oben).
