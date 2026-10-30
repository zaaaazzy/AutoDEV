# Benutzerhandbuch: Ideen mehrfach ablehnen und priorisieren

Stand: 30.10.2026 · Auftrag e8de4bd4

Dieses Kapitel beschreibt die neuen Aktionen in der Ideenliste: **Ablehnen mit Grund** und **Priorität setzen** für markierte Ideen sowie **Schnell ablehnen** für eine einzelne Idee.

> **Printscreens:** noch nicht erstellt. Im Workspace fehlen Chromium, Chrome und Firefox, und der Playwright-Cache liegt außerhalb des erlaubten Bereichs. Außerdem läuft keine App mit Datenbank. Die Abschnitte unten beruhen auf dem Quelltext. Die Platzhalter stehen in Abschnitt 9.
>
> **Tests:** Für diesen Stand sind Typecheck und Tests nicht gelaufen (`tsc` fehlt im Image, der npm-Cache gehört root).

## 1. Überblick

| Aktion | Wo | Wirkung |
|---|---|---|
| Ablehnen mit Grund | Bulk-Leiste, sobald Ideen markiert sind | Alle markierten zulässigen Ideen werden abgelehnt, mit gleichem Grund |
| Priorität setzen | Bulk-Leiste, sobald Ideen markiert sind | Alle markierten zulässigen Ideen erhalten Niedrig, Mittel oder Hoch |
| Schnell ablehnen | Aktionsspalte jeder Zeile (⊘ neben ✎) | Eine Idee wird mit Grund abgelehnt |

Alle drei Aktionen schreiben nur in Ideen. Aufträge (`development_items`) ändern sich dabei nicht.

## 2. Voraussetzungen

- **Rolle „Planung“** ist nötig. Ohne sie fehlen die Knöpfe. Der Server prüft dieselbe Rolle und lehnt die Aktion ab, falls jemand den Knopf anders auslöst.
- **Auswählbar** sind nur Ideen mit dem Status **Idee**, **In Überlegung** oder **Prüfung**. Ideen mit Status **Angefordert**, **In Ausarbeitung**, **Angenommen** oder **Abgelehnt** lassen sich nicht markieren. Ideen, zu denen schon ein Auftrag existiert, auch nicht.
- Eine Auswahl umfasst höchstens **200 Ideen**.

## 3. Mehrere Ideen ablehnen

1. Markiere eine oder mehrere Ideen in der Ideenliste. Die Bulk-Leiste erscheint mit der Zahl der Markierungen.
2. Klicke in der Bulk-Leiste auf **Ablehnen mit Grund**. Ein Popover öffnet sich mit dem Feld **Ablehnungsgrund (der Visionär beachtet ihn beim nächsten Lauf)**.
3. Schreibe den Grund. Er ist **Pflicht**, wird vor dem Speichern um Leerzeichen am Anfang und Ende gekürzt und darf höchstens **1000 Zeichen** lang sein. Solange das Feld leer oder nur mit Leerzeichen gefüllt ist, ist der Knopf deaktiviert.
4. Klicke auf **Idee ablehnen** (bei mehreren Ideen: **<Anzahl> Ideen ablehnen**). Es gibt keine weitere Bestätigung.

Was danach passiert:

- Jede zulässige Idee bekommt den Status **Abgelehnt** und den eingegebenen Grund.
- Jede Idee bekommt genau einen Kommentar mit dem Text `**Abgelehnt:** <Grund>`.
- Die Ideen wandern von **Offene Ideen** nach **Abgeschlossene Ideen**.
- Die Aktion läuft als Ganzes: Entweder werden alle zulässigen Ideen mit Grund und Kommentar gespeichert, oder keine. Schlägt die Speicherung fehl, bleibt jede Idee unverändert.

Die Meldung nennt die Ergebnisse, zum Beispiel „3 von 3 Ideen abgelehnt.“ (bei einer Idee: „Idee abgelehnt.“). Danach wird die Liste neu geladen und die Markierung geleert.

## 4. Priorität setzen

1. Markiere Ideen in der Ideenliste.
2. Klicke in der Bulk-Leiste auf **Priorität setzen**. Ein Popover zeigt die Stufen **Niedrig**, **Mittel**, **Hoch** und **Abbrechen**.
3. Klicke auf eine Stufe. Sie wird sofort bei allen markierten zulässigen Ideen gesetzt. Es braucht keinen Grund und keine Bestätigung.

Die Meldung lautet etwa „2 von 2 Ideen neu priorisiert.“. Danach werden Liste und Markierung wie bei der Ablehnung aktualisiert.

## 5. Schnell ablehnen (eine Idee)

Der Knopf **⊘** (Tooltip „Schnell ablehnen“) steht in der Aktionsspalte neben dem Bearbeiten-Knopf ✎. Er erscheint nur, wenn beide Bedingungen zutreffen:

- Die Idee hat den Status **Idee**, **In Überlegung** oder **Prüfung**.
- Du hast die Rolle **Planung**.

Abgelehnte Ideen zeigen den ✎-Knopf, aber keinen ⊘-Knopf. Ideen in Bearbeitung durch den Auftragsautor zeigen keinen von beiden.

1. Klicke auf ⊘. Das Popover zeigt den Titel der Idee und das Grundfeld.
2. Schreibe den Grund (Pflicht, höchstens 1000 Zeichen). **Ablehnen** ist erst aktiv, wenn Text drin steht.
3. Klicke auf **Ablehnen**. Die Idee erhält dieselbe Speicherung und denselben Kommentar wie bei der Massenablehnung und erscheint danach unter **Abgeschlossene Ideen** mit dem Status **Abgelehnt**.

**Abbrechen** oder **Escape** schließt das Popover ohne Speichern. Der Ideen-Dialog dahinter bleibt offen. Ein Klick außerhalb des Popovers schließt es ebenfalls ohne Speichern.

## 6. Was der Visionär damit macht

Bei späteren Visionär-Läufen führt der Abschnitt **Abgelehnte Ideen** Titel und Grund der abgelehnten Ideen auf. Der Visionär schlägt sie dann nicht erneut vor und beachtet den Grund. Die Massenaktionen füllen nur die Daten, die der Visionär ohnehin liest.

## 7. Was sich nicht ändert

- Es gibt kein Rückgängig-Machen und kein Massen-Löschen.
- Es entstehen keine neuen Status und keine neuen Spalten.
- Aufträge (`development_items`) und deren Priorität bleiben unverändert.
- „Aufträge erstellen“ und „Übernehmen“ funktionieren wie bisher.
- Ideen, die der Auftragsautor gerade bearbeitet (Status Angefordert oder In Ausarbeitung), werden nicht überschrieben.

## 8. Meldungen und Fehler

| Situation | Was du siehst |
|---|---|
| Grund leer oder nur Leerzeichen | Der Knopf **Idee ablehnen** bzw. „<Anzahl> Ideen ablehnen“ ist deaktiviert. |
| Grund länger als 1000 Zeichen | Das Feld nimmt keine weiteren Zeichen an. Der Server lehnt eine solche Anfrage mit HTTP 400 ab. |
| Mehr als 200 Ideen ausgewählt | Der Server lehnt die Anfrage mit HTTP 400 ab („Bitte 1 bis 200 Ideen auswählen.“). |
| Idee hat nicht erlaubten Status | Sie bleibt unverändert. Meldung: „Nicht möglich: <Titel> (<Status>).“ |
| Idee gibt es nicht mehr oder sie gehört zu einem Projekt, auf das du keinen Zugriff hast | Sie bleibt unverändert. Meldung: „Nicht gefunden: <Anzahl> Ideen.“ |
| Server-Fehler während einer Massenablehnung | Es wird nichts gespeichert. Die Oberfläche zeigt eine Fehlermeldung. |

Die Meldung nach einer Aktion nennt zuerst die geänderten Ideen und danach die übersprungenen, jeweils mit Grund.

Hinweis: Eine Idee steht selten im Status „Nicht möglich“, weil die Oberfläche nur zulässige Ideen markieren lässt. Das passiert zum Beispiel, wenn sich der Status seit dem Markieren geändert hat (etwa durch den Auftragsautor). Lade die Liste dann neu.

## 9. Printscreens (ausstehend)

Noch nicht erstellt. Die Aufnahmen brauchen eine laufende App mit Datenbank und einem Browser. Bilder habe ich nicht erfunden, und die vorhandenen Screenshots unter `docs/tests/` und `docs/styles-nach-bereich-2026-10-23/` stammen vom 22.–24.10. und zeigen die Bulk-Leiste nicht.

Gewünschte Aufnahmen (Vorschlag für Dateinamen unter `docs/benutzerhandbuch-massen-ablehnen-und-prioritaet-in-der-ideenliste-2026-10-30/`):

1. `01-bulk-leiste.png`: Ideenliste mit zwei markierten Ideen. Die Bulk-Leiste zeigt „Aufträge erstellen“, „Ablehnen mit Grund“ und „Priorität setzen“. → Abschnitt 1 und 3.
2. `02-ablehnen-popover.png`: Popover „Ablehnen mit Grund“ mit eingegebenem Grund und Knopf „2 Ideen ablehnen“. → Abschnitt 3.
3. `03-prioritaet-popover.png`: Popover „Priorität setzen“ mit Niedrig, Mittel, Hoch und Abbrechen. → Abschnitt 4.
4. `04-zeile-schnell-ablehnen.png`: Zeile mit ✎ und ⊘ „Schnell ablehnen“. → Abschnitt 5.
5. `05-schnell-ablehnen-popover.png`: Popover mit Titel der Idee und Grundfeld. → Abschnitt 5.
6. `06-abgeschlossen-abgelehnt.png`: „Abgeschlossene Ideen“ mit einer abgelehnten Idee, Status „Abgelehnt“. → Abschnitt 5.
7. `07-ohne-planung.png`: Ideenliste mit einem Konto ohne Rolle „Planung“. Bulk-Leiste und ⊘ fehlen. → Abschnitt 2.

Nach der Aufnahme die Platzhalter durch Bildlinks ersetzen.

## 10. Offen

- Typecheck, `src/api/app.test.ts` und die neuen E2E-Tests sind noch nicht gelaufen.
- Browser-Prüfung mit einem Konto ohne Rolle „Planung“ (Knöpfe fehlen) und mit fremdem Projekt („Nicht gefunden“) steht aus.
- Die Oberfläche wurde nicht im Browser gesehen. Die Angaben beruhen auf `ideation.component.html`, `ideation.component.ts`, `reject-reason-form.component.ts` und `src/api/ideation.ts`.
