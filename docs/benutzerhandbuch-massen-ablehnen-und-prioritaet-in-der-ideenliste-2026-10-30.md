# Benutzerhandbuch: Ideen mehrfach ablehnen und priorisieren

Auftrag e8de4bd4. Dieses Kapitel beschreibt die neuen Aktionen in der Ideenliste.

> **Printscreens:** keine. Die App lief für diesen Auftrag nicht. Die Angaben stammen aus Code und Auftrag. Die Tests wurden für dieses Handbuch nicht ausgeführt.

## 1. Rolle

Alle drei Aktionen brauchen die Rolle **Planen**. Ohne sie fehlen die Knöpfe.

## 2. Mehrere Ideen ablehnen

1. Markiere in der Ideenliste eine oder mehrere Ideen.
2. Klicke in der Bulk-Leiste auf **Ablehnen mit Grund**.
3. Gib einen Grund ein (Pflicht, höchstens 1000 Zeichen). Ohne Grund, oder nur mit Leerzeichen, ist die Aktion deaktiviert.
4. Klicke im Popover auf **Idee ablehnen** (bei mehreren Ideen: **<Anzahl> Ideen ablehnen**). Es gibt keinen weiteren Bestätigungsschritt. Alle zulässigen Ideen erhalten den Status „Abgelehnt“ und denselben Grund. Jede bekommt einen Kommentar `**Abgelehnt:** <Grund>`.

Die Ideen wechseln von „Offene Ideen“ nach „Abgeschlossene Ideen“. Der Visionär listet Titel und Grund bei späteren Läufen im Abschnitt „Abgelehnte Ideen“ auf.

Das Ablehnen läuft als Ganzes: Schlägt es serverseitig fehl, bleibt jede Idee unverändert.

## 3. Priorität setzen

1. Markiere Ideen in der Ideenliste.
2. Klicke in der Bulk-Leiste auf **Priorität setzen**. Ein Popover zeigt die Stufen **Niedrig**, **Mittel** und **Hoch** sowie **Abbrechen**.
3. Wähle eine Stufe. Sie wird sofort bei allen markierten Ideen gesetzt, ohne Grund und ohne weitere Bestätigung. Ideen, die nicht bearbeitbar sind, werden übersprungen (siehe Abschnitt 5).

Die Priorität gilt nur für Ideen. Aufträge (`development_items`) ändern sich dadurch nicht.

## 4. Schnell ablehnen

Bei Ideen mit Status `idea`, `considering` oder `review` steht neben ✎ der Knopf ⊘ **Schnell ablehnen**. Er öffnet ein Popover mit Grundfeld. Mit **Escape** schließt es, ohne etwas zu speichern, und der Dialog dahinter bleibt offen.

## 5. Meldung nach der Aktion

Die Liste wird neu geladen, und eine Meldung nennt, welche Ideen geändert wurden und welche übersprungen wurden. Übersprungen werden:

- Ideen mit Status `requested`, `drafting`, `accepted` oder `rejected`: „nicht möglich“.
- Ideen, die es nicht gibt oder die zu einem Projekt gehören, auf das du keinen Zugriff hast: „nicht gefunden“.

## 6. Grenzen

- Höchstens 200 Ideen pro Aktion, sonst lehnt der Server mit 400 ab. Ohne Grund ebenfalls 400.
- Abgelehnte Ideen lassen sich nicht wieder zurückholen. Massen-Löschen gibt es nicht.
- Aufträge (`development_items`) ändern sich nicht.

## 7. Fehlerbehebung

- **Knöpfe fehlen:** Du hast die Rolle „Planen“ nicht.
- **Idee wurde übersprungen:** Sie wird gerade vom Auftragsautor bearbeitet oder ist schon angenommen oder abgelehnt. Lade die Liste neu.

## Printscreens (ausstehend)

Für dieses Kapitel gibt es noch keine Printscreens. Benötigt werden, sobald die App mit Datenbank und Browser läuft:

1. Ideenliste mit markierten Ideen: Bulk-Leiste mit „Aufträge erstellen“, „Ablehnen mit Grund“ und „Priorität setzen“.
2. Popover „Ablehnen mit Grund“ mit Grundfeld und Knopf „<Anzahl> Ideen ablehnen“.
3. Popover „Priorität setzen“ mit Niedrig, Mittel, Hoch und Abbrechen.
4. Zeile mit ✎ und ⊘ **Schnell ablehnen**, geöffnetes Popover mit Grundfeld.
5. „Abgeschlossene Ideen“ mit einer abgelehnten Idee im Status „Abgelehnt“.

## Offen

- Printscreens (oben) und ein Browser-Lauf fehlen.
- Browser-Prüfung mit Nicht-Admin auf fremde Projekte („nicht gefunden“).
