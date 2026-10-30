# Benutzerhandbuch: Kalibrierte Schätzung, Laufwarnung und Schätzfehler-Trend

Dieses Kapitel beschreibt drei Neuerungen: die feinere Kalibrierung der Schätzung von Aufträgen, das Dashboard-Panel „Schätzung überschritten“ und den Verlauf „Schätzfehler je Sprint“ in der Statistik.

## Printscreens (ausstehend)

In der Umgebung, in der dieses Kapitel entstanden ist, lässt sich kein Browser starten. Deshalb liegen noch keine Aufnahmen vor. Für eine vollständige Fassung werden diese fünf Aufnahmen benötigt:

1. **Auftragsautor, Prompt-Zeile:** Ideen-Anforderung mit Schätzung, Ausschnitt der Zeile „Korrekturfaktor bisheriger Schätzungen (Ist ÷ Schätzung) …“ (aus dem Laufprotokoll des Auftragsautors).
2. **Dashboard, Panel „Schätzung überschritten“:** mit mindestens einer Warnung, Desktop-Ansicht.
3. **Dashboard, Panel „Schätzung überschritten“:** Handy-Ansicht, damit die Zeile vollständig lesbar bleibt.
4. **Statistik, Abschnitt „Schätzfehler je Sprint“:** mit mehreren Sprints in Reihenfolge und einem Sprint ohne Messung („Kein Schätzfehler: …“).
5. **Statistik, Leerzustand:** Projekt ohne Sprints, damit der Hinweis „Noch keine Sprints vorhanden.“ gezeigt wird.

Zum Aufnehmen braucht es einen Host mit laufender App und Datenbank.

Geprüft in diesem Lauf: In der Umgebung fehlen ein Chromium-Browser, Docker und die Abhängigkeiten des Frontends (`frontend/node_modules`). Der Browser-Cache unter `~/.cache/ms-playwright` liegt außerhalb des Arbeitsverzeichnisses und ist für den Agenten nicht lesbar. Deshalb wurde kein Printscreen erzeugt und keiner nachgebildet.

## 1. Kalibrierte Schätzung des Auftragsautors

### Was passiert

Der Auftragsautor schätzt Stunden (Agent-Laufzeit) und Tokens einer Anforderung, die aus einer Idee entsteht. Er stützt sich dabei auf erledigte Aufträge des Projekts. Die Kalibrierung ordnet jeden erledigten Auftrag einer Gruppe zu:

- **Art:** Feature oder Bugfix (Anzeige „Feature“ bzw. „Bugfix“).
- **Kategorie** des Auftrags, z. B. „backend“.
- **Schrittklasse:** die Zahl der Agent-Schritte über alle Läufe des Auftrags
  - bis 10 Schritte
  - 11 bis 20 Schritte (ein Auftrag mit 12 Schritten gehört hierhin, nicht zu „bis 10“)
  - mehr als 20 Schritte

Für den Auftragsautor gilt: Die Schrittklasse ist die Länge des Workflows des Projekts, nicht die Schrittzahl eines bestimmten Auftrags. Hat das Projekt keinen Workflow, fällt die Schrittklasse weg.

### Bedingungen

- **Mindestens 5 Messwerte** (`MIN_CALIBRATION_SAMPLES`) braucht eine Gruppe, damit ihr Faktor gilt.
- **Stufenweiser Rückfall**, wenn eine Gruppe zu wenige Messwerte hat. Die Reihenfolge ist:
  1. Art, Kategorie und Schrittklasse (entfällt, wenn keine Schrittklasse bekannt ist)
  2. Art und Kategorie
  3. nur Art (im Projekt)
  4. alle Aufträge des Projekts
  5. alle Aufträge aller Projekte
  6. Standard ×1
- Je Projekt zählen nur die **jüngsten 20 erledigten Aufträge** (`CALIBRATION_WINDOW`) einer Herkunft.
- **Nur erledigte Aufträge** zählen (Status „erledigt“, ohne Express-Aufträge). Setzt man einen erledigten Auftrag zurück, verschwindet er aus der Kalibrierung.
- **Kein Speichern nötig:** Ein Auftrag, der erledigt wird, ändert den Faktor der nächsten Schätzung sofort. Es gibt keine eigene Tabelle und keinen Speicherschritt.
- **Altbestand (`legacy`):** Schätzungen mit dieser Herkunft gehen nicht in den Prompt des Auftragsautors ein. Für die Stundenkalibrierung des Altbestands zählen sie weiterhin.
- **Keine rückwirkende Neuberechnung:** Bereits gespeicherte Schätzungen ändern sich nicht.
- **Schnellschätzung** von Ideen (`quickEstimate`) erhält keinen Korrekturfaktor. Sie nutzt weiterhin nur den Median vergleichbarer Aufträge nach Kategorie.

### Was im Prompt steht

Neben dem Median vergleichbarer Aufträge erscheint eine Zeile dieser Form (die Zahlen sind ein Beispiel):

> Korrekturfaktor bisheriger Schätzungen (Ist ÷ Schätzung): Stunden ×1,4 (12 Messwerte, Gruppe: Feature · Kategorie backend · 11 bis 20 Schritte (dieses Projekt)); Tokens ×0,9 (…). Multipliziere deine erste Schätzung mit dem Faktor, bevor du sie angibst.

Ist die Gruppe zu dünn besetzt, lautet der Teil für Stunden stattdessen „Stunden ×1 (zu wenige Messwerte)“. Die Gruppe nennt die tatsächlich gewählte Stufe, damit sichtbar ist, wie belastbar der Faktor ist.

**Bekannte Einschränkung:** Der Auftragsautor schätzt nur Ideen, und Ideen werden immer als Feature geschätzt. Der Bugfix-Faktor ist deshalb in der Kalibrierung getrennt vorhanden, wirkt im Prompt des Auftragsautors aber bisher nicht.

**Wichtig:** Der Faktor ist ein Hinweis für den Auftragsautor. Die gespeicherte Schätzung wird nicht automatisch umgerechnet.

## 2. Dashboard: Panel „Schätzung überschritten“

### Was es anzeigt

Das Panel listet laufende Aufträge, deren gemessener Verbrauch mehr als das **Dreifache** ihrer kalibrierten Schätzung beträgt. Laufzeit und Tokens werden getrennt geprüft. Jede Zeile zeigt den Titel, den Status und das Überschrittene, z. B.:

> Laufzeit 6,2 h statt 2 h (3,1×) · Tokens 400.000 statt 100.000 (4×)

Die Überschrift lautet „Schätzung überschritten“, der Untertitel „mehr als 3× der kalibrierten Schätzung“. Ein Klick auf eine Zeile öffnet die Entwicklungsansicht mit diesem Auftrag (Sprunglink, keine Änderung am Auftrag). Die Liste ist absteigend nach dem größten Verhältnis sortiert.

### Bedingungen

- **Nur bei Warnungen sichtbar.** Ohne überschrittene Aufträge fehlt das Panel vollständig.
- **Position:** im Startbereich des Projekts, nach den Kennzahlen und dem Chat, vor der Projektübersicht. Das Panel steht als eigene Karte im Dashboard. Es gibt im Frontend keine Gruppe „Besondere Aufmerksamkeit“, zu der es gehören könnte.
- **Genau das Dreifache löst nicht aus.** Erst strikt mehr als das Dreifache zeigt die Warnung.
- **Unabhängig vom Budget:** Die Warnung erscheint auch dann, wenn noch kein Budget erreicht ist. Die Budget-Warnung bei 80 % bleibt davon getrennt.
- **Nur laufende Aufträge:** die Status „in Arbeit“ und „blockiert“. Erledigte, geplante oder Express-Aufträge erscheinen nicht.
- **Verbrauch über alle Läufe** des Auftrags und alle Schritte, unabhängig von Rolle und Status der Schritte. Ein Auftrag, der ohne fehlgeschlagenen Schritt hängt, wird also ebenfalls erfasst.
- **Vergleich mit der kalibrierten Schätzung**, nicht mit der rohen. Der Faktor stammt aus den erledigten Aufträgen derselben Herkunft wie der Auftrag selbst.
- **Ohne brauchbare Schätzung keine Warnung:** Fehlt die Schätzung oder ist sie 0, erscheint für diese Größe keine Warnung.
- **Fehler in der Prüfung blockieren nichts.** Das Panel bleibt dann leer, und der Fehler wird im Protokoll festgehalten.
- **Reine Anzeige:** Das Panel ändert nichts am Auftrag. Die Zeilen sind nur Sprunglinks. Es gibt keine Push-Nachricht und keine Blockade des Sprints.

## 3. Statistik: „Schätzfehler je Sprint“

### Was es zeigt

Für jeden Sprint steht der **Median von Ist ÷ Schätzung** über die erledigten Aufträge des Sprints, die gemessen wurden. Der Verlauf zeigt die letzten 8 Sprints, ältester zuerst.

- **Hauptwert:** der Schätzfehler der Laufzeit (Stunden).
- **Zweite Zeile:** der Schätzfehler der Tokens und die Anzahl der gemessenen Aufträge.
- **Balken:** logarithmisch um 1× zentriert (50 % = genau geschätzt). Ein kürzerer Balken bedeutet, dass weniger verbraucht wurde als geschätzt, ein längerer, dass mehr verbraucht wurde.

Die Werte sind **roh**, also ohne Korrekturfaktor. Sie zeigen, wie gut die Schätzungen ohne Korrektur waren.

Lesehilfe: **1×** bedeutet genau geschätzt, **2,4×** bedeutet, dass der Ist-Wert im Median das 2,4-Fache der Schätzung betrug.

### Bedingungen

- Es zählen nur **erledigte** Aufträge mit Messung (Laufzeit bzw. Tokens).
- **Sprint ohne solche Aufträge:** Der Wert ist leer („–“) und wird **nicht** als 0 gezählt. Die Zeile zeigt „Kein Schätzfehler: noch keine erledigten Aufträge mit Messung“.
- Gemessen wird die Summe aller Läufe und Schritte eines Auftrags. Auftragsgröße und Herkunft der Schätzung fließen hier nicht in eine Gruppe ein.
- **Leerzustand:** Gibt es keine Sprints, steht dort „Noch keine Sprints vorhanden.“ Der Verlauf erwähnt keine Filter.

## Grenzen

- Die 34-fachen Abweichungen, die die Idee nennt, stammen vermutlich aus dem Altbestand mit Menschenstunden. Das ist noch nicht gegen echte Daten geprüft.
- Die Warnung vergleicht mit der **kalibrierten** Schätzung. Ein Auftrag, dessen Herkunftsfaktor ohnehin hoch war, gilt damit nicht automatisch als Ausreißer.
- Die Schwelle (3×) steht als Konstante `OVERRUN_FACTOR` und die Schrittklassen (10 und 20) als `STEP_CLASS_LIMITS` in `src/core/estimate-overrun.ts`. Eine Änderung erfolgt nur dort.
- Push-Benachrichtigungen gibt es nicht. Sie können später folgen.
- Der Bugfix-Faktor wirkt bisher nicht im Prompt des Auftragsautors (siehe Abschnitt 1).
