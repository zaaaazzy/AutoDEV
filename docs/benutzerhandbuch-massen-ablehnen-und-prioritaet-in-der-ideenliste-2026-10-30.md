# Benutzerhandbuch: Ideen mehrfach ablehnen und priorisieren

Auftrag e8de4bd4. Dieses Kapitel beschreibt die neuen Aktionen in der Ideenliste.

> **Printscreens:** keine. Die App lief für diesen Auftrag nicht. Die Angaben stammen aus Code und Auftrag. Die Tests wurden für dieses Handbuch nicht ausgeführt.

## 1. Rolle

Alle drei Aktionen brauchen die Rolle **Planen**. Ohne sie fehlen die Knöpfe.

## 2. Mehrere Ideen ablehnen

1. Markiere in der Ideenliste eine oder mehrere Ideen.
2. Klicke in der Bulk-Leiste auf **Ablehnen mit Grund**.
3. Gib einen Grund ein (Pflicht, höchstens 1000 Zeichen). Ohne Grund, oder nur mit Leerzeichen, ist die Aktion deaktiviert.
4. Bestätige. Alle zulässigen Ideen erhalten den Status „Abgelehnt“ und denselben Grund. Jede bekommt einen Kommentar `**Abgelehnt:** <Grund>`.

Die Ideen wechseln von „Offene Ideen“ nach „Abgeschlossene Ideen“. Der Visionär listet Titel und Grund bei späteren Läufen im Abschnitt „Abgelehnte Ideen“ auf.

Das Ablehnen läuft als Ganzes: Schlägt es serverseitig fehl, bleibt jede Idee unverändert.

## 3. Priorität setzen

Markiere Ideen, klicke **Priorität setzen** und wähle Niedrig, Mittel oder Hoch. Die Priorität wird bei allen zulässigen Ideen gesetzt.

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

## Offen

- Printscreens und ein Browser-Lauf fehlen.
