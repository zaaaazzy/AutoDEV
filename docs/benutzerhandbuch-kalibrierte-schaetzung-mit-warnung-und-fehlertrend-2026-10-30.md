# Benutzerhandbuch: Kalibrierte Schätzung, Laufwarnung und Schätzfehler-Trend

Dieses Kapitel beschreibt drei Neuerungen: die feinere Kalibrierung der Schätzung von Aufträgen, das Dashboard-Panel „Schätzung überschritten“ und den Verlauf „Schätzfehler je Sprint“ in der Statistik.

## Printscreens (ausstehend)

In der Umgebung, in der dieses Kapitel entstanden ist, lässt sich kein Browser starten. Deshalb liegen noch keine Aufnahmen vor. Für eine vollständige Fassung werden diese fünf Aufnahmen benötigt:

1. **Auftragsautor, Prompt-Zeile:** Auftrag mit Schätzung im Verlauf, Ausschnitt der Zeile „Korrekturfaktor bisheriger Schätzungen (Ist ÷ Schätzung) …“ (aus dem Prompt bzw. dem Laufprotokoll).
2. **Dashboard, Panel „Schätzung überschritten“:** mit mindestens einer Warnung, Desktop-Ansicht.
3. **Dashboard, Panel „Schätzung überschritten“:** Handy-Ansicht, damit die Zeile vollständig lesbar bleibt.
4. **Statistik, Abschnitt „Schätzfehler je Sprint“:** mit mehreren Sprints in Reihenfolge und einem Sprint ohne Messung („Kein Schätzfehler: …“).
5. **Statistik, Leerzustand:** Projekt ohne erledigte, gemessene Aufträge, damit der neutrale Hinweis gezeigt wird.

## 1. Kalibrierte Schätzung des Auftragsautors

### Was passiert

Der Auftragsautor schätzt Stunden (Agent-Laufzeit) und Tokens eines neuen Auftrags. Er stützt sich dabei auf erledigte Aufträge des Projekts. Die Kalibrierung ordnet jeden erledigten Auftrag einer Gruppe zu:

- **Art:** Feature oder Bugfix. Ein Bugfix mit gleicher Kategorie erhält eigenen Korrekturfaktor.
- **Kategorie** des Auftrags (z. B. Backend).
- **Schrittklasse:** die Zahl der Agent-Schritte über alle Läufe des Auftrags.
  - bis 10 Schritte
  - 11 bis 20 Schritte (ein Auftrag mit 12 Schritten gehört hierhin, nicht zu „bis 10“)
  - mehr als 20 Schritte

### Bedingungen

- **Mindestens 5 Messwerte** (`MIN_CALIBRATION_SAMPLES`) braucht eine Gruppe, damit ihr Faktor gilt.
- **Stufenweiser Rückfall**, wenn eine Gruppe zu wenige Messwerte hat:
  1. Art und Kategorie
  2. nur Art
  3. alle Aufträge des Projekts (bzw. aller Projekte)
  4. Standard ×1
- Der Prompt nennt die tatsächlich gewählte Stufe, damit sichtbar ist, wie belastbar der Faktor ist.
- **Nur erledigte Aufträge** zählen. Setzt man einen erledigten Auftrag zurück, verschwindet er aus der Kalibrierung.
- **Kein Speichern nötig:** Ein Auftrag, der erledigt wird, ändert den Faktor der nächsten Schätzung sofort. Es gibt keine eigene Tabelle und keinen Speicherschritt.
- **Altbestand (`legacy`):** Schätzungen mit dieser Herkunft gehen nicht in den Prompt des Auftragsautors ein. Für die Stundenkalibrierung des Altbestands zählen sie weiterhin.
- **Schnellschätzung** von Ideen bleibt unverändert, nutzt aber denselben gemeinsamen Faktor.
- **Keine rückwirkende Neuberechnung:** Bereits gespeicherte Schätzungen ändern sich nicht.

### Was im Prompt steht

Neben dem Median vergleichbarer Aufträge erscheint eine Zeile dieser Form (die Zahlen sind ein Beispiel):

> Korrekturfaktor bisheriger Schätzungen (Ist ÷ Schätzung): Stunden ×1,4 (12 Messwerte, Gruppe: Backend, Bugfix, 11 bis 20 Schritte); Tokens ×0,9 (…). Multipliziere deine erste Schätzung mit dem Faktor, bevor du sie angibst.

Ist eine Gruppe zu dünn besetzt, lautet der Teil stattdessen „Stunden ×1 (zu wenige Messwerte)“.

**Wichtig:** Der Faktor ist ein Hinweis für den Autor. Die gespeicherte Schätzung wird nicht automatisch umgerechnet.

## 2. Dashboard: Panel „Schätzung überschritten“

### Was es anzeigt

Das Panel listet laufende Aufträge, deren gemessener Verbrauch mehr als das **Dreifache** ihrer kalibrierten Schätzung beträgt. Geprüft werden Agent-Laufzeit und Tokens getrennt. Jede Zeile zeigt, was überschritten ist, z. B.:

> Laufzeit 6,2 h statt 2 h (3,1×) · Tokens 400.000 statt 100.000 (4×)

Ein Klick auf den Eintrag öffnet den Auftrag im Bereich Aufträge.

### Bedingungen

- **Nur bei Warnungen sichtbar.** Ohne überschrittene Aufträge fehlt das Panel vollständig.
- **Position:** ganz oben im Dashboard, vor der Projektübersicht. Die Überschrift des Panels lautet „Schätzung überschritten“. (Ob es in einer Gruppe „Besondere Aufmerksamkeit“ steht, ist im Frontend nicht belegt.)
- **Genau das Dreifache löst nicht aus.** Erst strikt mehr als das Dreifache zeigt die Warnung.
- **Unabhängig vom Budget:** Die Warnung erscheint auch dann, wenn noch kein Budget erreicht ist.
- **Nur laufende Aufträge** (intern die Status `in_progress` und `blocked`). Erledigte oder geplante Aufträge erscheinen nicht.
- **Verbrauch über alle Läufe** des Auftrags, unabhängig von Rolle und Status der Schritte. Ein Auftrag, der ohne fehlgeschlagenen Schritt hängt, wird also ebenfalls erfasst.
- **Ohne brauchbare Schätzung keine Warnung:** Fehlt die Schätzung oder ist sie 0, erscheint keine Warnung.
- **Fehler in der Prüfung** blockieren nichts. Das Panel bleibt dann leer, und der Fehler wird im Protokoll festgehalten.
- **Reine Anzeige:** Das Panel bietet keine Aktion. Es gibt keine Push-Nachricht und keine Blockade des Sprints.

## 3. Statistik: „Schätzfehler je Sprint“

### Was es zeigt

Für jeden Sprint steht der **Median von Ist ÷ Schätzung** über die erledigten Aufträge des Sprints, die gemessen wurden. Der Verlauf zeigt die letzten 8 Sprints, ältester zuerst. Die Werte sind **roh**, also ohne Korrekturfaktor. Sie zeigen, wie gut die Schätzungen ohne Korrektur waren.

Lesehilfe: **1×** bedeutet genau geschätzt, **2,4×** bedeutet, dass der Ist-Wert im Median das 2,4-Fache der Schätzung betrug.

### Bedingungen

- Es zählen nur **erledigte** Aufträge mit Messung (Laufzeit bzw. Tokens).
- **Sprint ohne solche Aufträge:** Der Wert ist leer („–“) und wird **nicht** als 0 gezählt. Die Zeile zeigt „Kein Schätzfehler: noch keine erledigten Aufträge mit Messung“.
- Die Zeile unter dem Verlauf nennt die Anzahl der gemessenen Aufträge.
- **Leerzustand:** Gibt es keine Sprints, steht dort „Noch keine Sprints vorhanden.“ Der Verlauf erwähnt keine Filter.

## Grenzen

- Die 34-fachen Abweichungen, die die Idee nennt, stammen vermutlich aus dem Altbestand mit Menschenstunden. Das ist noch nicht gegen echte Daten geprüft.
- Die Warnung vergleicht mit der **kalibrierten** Schätzung. Ein Auftrag, dessen Herkunftsfaktor ohnehin hoch war, gilt damit nicht automatisch als Ausreißer.
- Die Schwelle (3×) und die Schrittklassen sind feste Werte in `src/core/estimate-overrun.ts`. Eine Änderung erfolgt nur dort.
- Push-Benachrichtigungen gibt es nicht. Sie können später folgen.
