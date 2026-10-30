# Benutzerhandbuch: Abnahme-Häkchen springt nach einem Fehler zurück

Stand: 2026-10-29 · Auftrag `3a3acdb4` (Bugfix, Sprint 28) · Entwicklerdoku: `docs/abnahme-haekchen-nach-fehler-zuruecksetzen-2026-10-29.md`

## Was sich für dich ändert

Die Häkchen bei den offenen Abnahmepunkten zeigen jetzt nur noch an, was wirklich gespeichert ist. Vorher blieb ein Punkt
nach einem fehlgeschlagenen Abhaken geprüft aussehen, obwohl nichts gespeichert war.

- Schlägt das Abhaken fehl (Recht fehlt, Punkt schon anders, keine Verbindung), wird das Häkchen wieder leer.
- Oben erscheint die Fehlermeldung. Sie verschwindet nach einigen Sekunden, das Häkchen bleibt leer.
- Ohne das Recht „Planung“ ist das Häkchen ausgegraut. Ein Tooltip nennt den Grund.

Die Bedienung bleibt sonst gleich: Ein Klick auf das Häkchen speichert den Punkt.

**Printscreens: fehlen.** Dieser Lauf konnte AIdeation nicht starten, der Shell-Zugriff ist für Agents gesperrt. Die
Beschreibung stammt aus dem Code der Oberfläche, nicht aus dem Bildschirm. Die Aufnahmen stehen unter „Noch offen“.

## Wo du das findest

| Was | Wo in AIdeation | Sichtbar, wenn |
|---|---|---|
| Abnahme-Häkchen (Punkt abhaken) | Seite „Aktionen“, Karte mit dem Hinweis „… lässt sich nur von Hand prüfen“ (Liste der Punkte) | der Auftrag hat Punkte, die nur ein Mensch prüfen kann |
| Dasselbe Häkchen | Auftragsdetail, Abschnitt „Noch zu erledigen“ | der Auftrag hat offene Abnahmepunkte |

## Was passiert

### Punkt abhaken

1. Du klickst das Häkchen vor einem offenen Abnahmepunkt.
2. Während AIdeation speichert, bleibt das Häkchen gesetzt. Ein zweiter Klick auf dasselbe Häkchen wird ignoriert.
3. Bei Erfolg bleibt der Punkt abgehakt. Nach dem Neuladen gilt er als erledigt und steht nicht mehr unter den offenen
   Punkten.
4. Bei einem Fehler springt das Häkchen zurück auf leer. Die Meldung erscheint oben.

Das Häkchen speichert nur den einzelnen Punkt. Andere Punkte desselben Auftrags bleiben unverändert.

### Fehlgeschlagenes Abhaken

Die Meldung oben nennt den Grund aus dem Server. Typische Fälle:

- **403 (Keine Berechtigung):** Dir fehlt das Recht „Planung“. Frag einen Admin, ob du es bekommst. Das Häkchen ist
  dann ohnehin ausgegraut.
- **409 (Konflikt):** Der Punkt ist auf dem Server inzwischen anders, zum Beispiel schon abgehakt. Lade die Seite neu,
  bevor du es noch einmal versuchst.
- **Netzfehler:** Die Verbindung zum Server ist abgebrochen. Prüfe das Netz und klicke das Häkchen erneut an.

In allen drei Fällen ist der Punkt nicht gespeichert. Du kannst den Klick danach wiederholen.

## Bedingungen

- **Recht „Planung“.** Nur wer es hat, kann einen Abnahmepunkt abhaken. Ohne das Recht ist das Häkchen ausgegraut und
  zeigt den Tooltip „Abhaken braucht das Recht „Planung“.“. Der Server prüft das Recht zusätzlich und lehnt das Abhaken
  mit 403 ab. Die Sperre in der Oberfläche ist nur Bedienkomfort.
- **Während anderer Aktionen gesperrt.** Solange AIdeation gerade eine andere Aktion ausführt (zum Beispiel einen Sprint
  startet), sind alle Häkchen ebenfalls gesperrt. Warte, bis die Aktion fertig ist.
- **Während der Tester prüft.** Im Auftragsdetail ist ein Punkt gesperrt, solange der Tester ihn gerade prüft (Anzeige
  „🤖 Tester prüft …“). Warte, bis die Prüfung fertig ist.
- **Ein Klick pro Punkt.** Während ein Punkt gespeichert wird, sendet ein weiterer Klick auf denselben Punkt nichts.
  Andere Punkte kannst du in der Zwischenzeit abhaken.
- **Nur offene Punkte.** Abgehakte Punkte verschwinden aus der Liste der offenen Punkte, sobald die Daten neu geladen
  sind.

## Fehlermeldungen und Behebung

| Meldung oder Zustand | Ursache | Was du tust |
|---|---|---|
| Häkchen ausgegraut, Tooltip „Abhaken braucht das Recht „Planung“.“ | Dir fehlt das Recht „Planung“ | Admin bitten, das Recht zu geben |
| Häkchen springt nach dem Klick leer zurück, Fehler oben (403) | Server lehnt ab, Recht fehlt | wie oben: Recht prüfen lassen |
| Häkchen springt leer zurück, Fehler oben (409) | Punkt ist auf dem Server anders | Seite neu laden |
| Häkchen springt leer zurück, Fehler oben (Netz) | Verbindung unterbrochen | Netz prüfen, Klick wiederholen |
| Häkchen ausgegraut, obwohl du das Recht hast | Eine andere Aktion läuft, oder der Tester prüft diesen Punkt gerade | kurz warten, dann erneut versuchen |

## Noch offen

- **Printscreens fehlen.** Benötigt werden vier Aufnahmen: (1) Karte „Aktionen“ mit offenen Punkten, (2) ausgegrauetes
  Häkchen mit Tooltip ohne Recht „Planung“, (3) Häkchen leer nach fehlgeschlagenem Abhaken mit Fehlermeldung oben,
  (4) Auftragsdetail „Noch zu erledigen“.
- **Browser nicht geprüft.** Ob das Häkchen im echten Browser nach einem Netzfehler leer bleibt, ist offen.

Die Tests sind gelaufen (Entwickler und Projekt-Testlauf cb63990a, nicht von diesem Agenten gestartet): `npm run test:unit`
mit 1782 Tests, 0 fehlgeschlagen. Die Typprüfung und `acceptance-ticks.spec.ts` sowie `sprint-actions.spec.ts` sind
grün (13/13). Die Beschreibung oben stützt sich auf die Oberflächen-Vorlagen und die Klasse `AcceptanceTicks`, die ich gelesen habe.
