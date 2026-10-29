# Benutzerhandbuch: Knöpfe im Sprint-Detail

Auftrag eb3986f5 (Bugfix, Sprint 23). Dieses Kapitel beschreibt, welche Knöpfe im Sprint-Detail erscheinen, unter welchen Bedingungen sie angeboten werden und was passiert, wenn du sie drückst.

> **Was sich geändert hat:** Vorher zeigte das Sprint-Detail „Bearbeiten“, „Sprint starten“, „Live schalten“, „Wieder öffnen“, „Abbrechen“, „Wieder planen“ und „Löschen“ immer an, unabhängig von Status, laufenden Aufträgen, anderem aktiven Sprint und deiner Rolle. Bei einem Klick kam dann erst der Fehler vom Server (409 oder 403). Jetzt erscheint ein Knopf nur, wenn Server und Rolle ihn erlauben. Die Regeln liegen in einer gemeinsamen Datei (`src/core/sprint-rules.ts`), die Oberfläche und der Server nutzen dieselben.
>
> **Printscreens:** keine. Die App lief für diesen Auftrag nicht, und ein Browser-Lauf ist nicht erfolgt. Die Bedingungen unten stammen aus dem Code (`frontend/src/app/features/sprints/sprint-actions.ts`, `sprint-detail.component.html`) und den Regeln in `src/core/sprint-rules.ts`. Die Tests wurden für dieses Handbuch nicht ausgeführt.

Die Meldungen zu den Sprint-Regeln stehen auch in [`benutzerhandbuch-regeln-auftraege-sprints-bugs.md`](benutzerhandbuch-regeln-auftraege-sprints-bugs.md), Kapitel 4. Dort ist auch beschrieben, was der Server bei den einzelnen Wechseln ablehnt.

---

## 1. Welche Rolle du brauchst

| Knopf | Rolle | Sonst |
| --- | --- | --- |
| Bearbeiten, Sprint starten, Live schalten, Wieder öffnen, Abbrechen, Wieder planen, Löschen | **Planung** | fehlt |
| Pausieren, Fortsetzen | **Ausführen** | fehlt |

Hast du nur „Ausführen“, siehst du im Sprint-Detail nur Pausieren und Fortsetzen (falls der Sprint aktiv ist). Hast du nur „Planung“, fehlen Pausieren und Fortsetzen.

---

## 2. Bedingungen je Knopf

| Knopf | Erscheint, wenn | Wird ausgeblendet, wenn |
| --- | --- | --- |
| **Bearbeiten** | Rolle „Planung“ | – |
| **Sprint starten** | Rolle „Planung“, Sprint ist geplant, und kein anderer Sprint des Projekts ist aktiv | anderer Sprint aktiv |
| **Pausieren** | Rolle „Ausführen“, Sprint ist aktiv und nicht pausiert | Sprint nicht aktiv oder schon pausiert |
| **Fortsetzen** | Rolle „Ausführen“, Sprint ist aktiv und pausiert | Sprint nicht aktiv oder nicht pausiert |
| **Live schalten** | Rolle „Planung“ und Sprint ist aktiv | Sprint nicht aktiv (Knopf ist dann ganz weg) |
| **Wieder öffnen** | Rolle „Planung“, Sprint ist abgeschlossen, und kein anderer Sprint des Projekts ist aktiv | anderer Sprint aktiv oder Sprint nicht abgeschlossen |
| **Abbrechen** | Rolle „Planung“ und Sprint ist geplant oder aktiv | Sprint ist in einem anderen Status |
| **Wieder planen** | Rolle „Planung“ und Sprint ist abgebrochen | Sprint nicht abgebrochen |
| **Löschen** | Rolle „Planung“ und der Sprint darf gelöscht werden (siehe unten) | Sprint darf nicht gelöscht werden |

### 2.1 Löschen

Der Knopf erscheint nur, wenn der Sprint **geplant, abgeschlossen oder abgebrochen** ist, keine laufende Git-Sicherung hat und keine Aufträge laufen oder auf Freigabe warten. Sonst fehlt er ganz.

### 2.2 Sprint starten und Wieder öffnen

Beide fehlen, solange im Projekt schon ein anderer Sprint aktiv ist. Pro Projekt kann nur ein Sprint aktiv sein. Pausiere oder schließe den aktiven Sprint zuerst ab.

### 2.3 Live schalten

Dieser Knopf **bleibt sichtbar**, auch wenn er gerade nicht geht. Er ist dann ausgegraut, und der Tooltip nennt den Grund. Das passiert, solange

- Aufträge in diesem Sprint noch laufen, oder
- Aufträge auf Freigabe warten.

Erst wenn beides leer ist, lässt sich der Knopf drücken.

---

## 3. Sperre während einer Anfrage

Sobald du einen Knopf drückst, sind alle Knöpfe des Sprint-Detail gesperrt, bis die Antwort des Servers da ist. Das gilt auch während einer Rückfrage („Sind Sie sicher?“). Ein Doppelklick auf „Sprint starten“ öffnet damit nur eine Rückfrage und schickt nur einen Auftrag an den Server.

Nach einem Fehler, etwa einem Netzausfall oder einer Ablehnung durch den Server, werden die Knöpfe wieder freigegeben. Du kannst die Aktion dann erneut versuchen.

---

## 4. Was der Server trotzdem prüft

Die Oberfläche zeigt nur, was gerade erlaubt ist. Der Server prüft jede Anfrage weiterhin selbst. Antworten bleiben wie bisher:

- **409** bei einem nicht erlaubten Statuswechsel oder einem Konflikt, zum Beispiel „Es kann nur ein Sprint pro Projekt aktiv sein.“ Diese Meldung kommt jetzt schon vor dem Git-Check, beim Start und beim Wieder öffnen.
- **403** bei fehlender Rolle.

Ein 409 oder 403 bekommst du also nur noch, wenn sich der Zustand zwischen Anzeige und Klick geändert hat, etwa weil ein anderer Benutzer den Sprint bearbeitet hat. Lade die Seite neu, dann stimmen die Knöpfe wieder.

---

## 5. Fehlerbehebung

- **Ein Knopf fehlt, obwohl ich ihn erwarte.** Prüfe in dieser Reihenfolge: Hast du die Rolle „Planung“ bzw. „Ausführen“? Ist der Sprint im richtigen Status (siehe Abschnitt 2)? Läuft in diesem Projekt ein anderer Sprint? Hängt noch ein Auftrag an Freigabe oder läuft noch ein Auftrag?
- **„Live schalten“ ist ausgegraut.** Den Grund zeigt der Tooltip. Meist laufen noch Aufträge oder einer wartet auf Freigabe.
- **Nach dem Abbrechen fehlt „Wieder planen“.** Der Knopf erscheint nur für abgebrochene Sprints. Hat der Sprint noch einen anderen Status, ist er nicht abgebrochen.
- **Ein Knopf bleibt gesperrt.** Warte die Antwort des Servers ab. Nach einem Fehler gehen die Knöpfe von selbst wieder. Hilft das nicht, lade die Seite neu.

---

## 6. Für Entwickler

- Die Regeln stehen nur in `src/core/sprint-rules.ts`. Änderungen dort wirken auf Server und Oberfläche gleichzeitig.
- Die Knopf-Logik steht in `frontend/src/app/features/sprints/sprint-actions.ts` (`sprintButtons`, `exclusive`).
- Neue Dateien unter `src/core` müssen in `deploy/frontend/Dockerfile`, `frontend/tsconfig.app.json` und `frontend/tsconfig.spec.json` eingetragen werden.
- Tests: `src/core/sprint-rules.test.ts` und `frontend/src/app/features/sprints/sprint-actions.spec.ts`.

## Offen

- Printscreens fehlen. Sie lassen sich nachholen, wenn die App lokal läuft.
- Die Tests sind für dieses Handbuch nicht erneut ausgeführt worden.
