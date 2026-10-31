# Benutzerhandbuch: Agenten per Drag & Drop zwischen Phasen verschieben

Dieses Kapitel beschreibt, wie du Schritte im Workflow-Panel umordnest und in eine andere Phase verschiebst. Auftrag ab7ebbab (Sprint 23). Die Entwicklerdoku steht in [`agenten-per-drag-and-drop-zwischen-phasen-2026-10-28.md`](agenten-per-drag-and-drop-zwischen-phasen-2026-10-28.md).

> **Printscreens: keine.** In dieser Sitzung lief weder die App noch eine Datenbank, und ein Browser stand nicht bereit. Die Beschreibung stammt aus dem Quelltext (`frontend/src/app/features/agents/workflow-steps.component.ts`, `workflow-order.ts`, `frontend/src/styles/14-agents.css`) und aus dem Endpunkt in `src/api/workflow.ts`. Die Aufnahmen stehen unter „Noch aufzunehmen“ am Ende.

---

## 1. Was sich ändert

Im Workflow-Panel (unter „Agents“, aufklappbare Karte „Workflow“) lassen sich Schritte jetzt auch mit der Maus verschieben:

- **Innerhalb einer Phase:** einen Schritt an eine neue Position ziehen.
- **In eine andere Phase:** einen Schritt über die Phasengrenze in eine andere Phase ziehen.
- **Speichern:** Die neue Reihenfolge wird sofort gespeichert und bleibt nach dem Neuladen erhalten.

Neu ist auch das Auswahlfeld „In Phase verschieben“ im Menü jedes Schritts. Es ist die Tastatur-Alternative zum Phasenwechsel. Die Pfeile ↑/↓ funktionieren wie bisher.

Die Phasen heißen im Panel so (in dieser Reihenfolge):

| Nummer | Name im Panel | Bedeutung laut Hinweis im Panel |
| --- | --- | --- |
| 1 | Vor dem Sprint | Einmal beim Sprintstart · nur lesend (Planung, Prüfung) |
| 2 | Vor dem Auftrag | Kontext prüfen und Auftrag vorbereiten |
| 3 | Während | Auftrag umsetzen |
| 4 | Danach | Tests, Review und Dokumentation |
| 5 | Bei abgelehnt | Wenn der Auftrag scheitert · ändert das Ergebnis nicht |
| 6 | Bei abgeschlossen | Wenn der Auftrag erledigt ist · ändert das Ergebnis nicht |

Im Panel heißt der erste Zeitpunkt „Vor dem Sprint“, nicht „Sprintstart“.

Brichst du einen laufenden Agent mit „Abbrechen“ ab oder brichst du den Sprint ab, startet danach kein weiterer Agent
des Auftrags. Auch die Agents „Bei abgelehnt“ laufen dann nicht.

## 2. Bedienung

### 2.1 Mit der Maus ziehen

1. Fasse den Griff **⠿** links neben der Nummer des Schritts an.
2. Ziehe den Schritt. Der gezogene Eintrag wird leicht transparent und bekommt einen weichen Schatten.
3. Über einer Zielstelle erscheint eine grüne Linie. Sie zeigt, wohin der Schritt kommt: oberhalb oder unterhalb des Schritts, der gerade darunter liegt.
4. Die Phase, über der du gerade bist, wird hervorgehoben: grüner linker Rand und grüne Nummer.
5. Lass los. Der Schritt wird an dieser Stelle eingefügt und gespeichert.

Lässt du an der Stelle los, an der der Schritt schon steht, passiert nichts. Es wird nichts gespeichert.

In einer leeren Phase steht „Kein Agent – mit „+ Agent“ hinzufügen.“. Ziehst du einen Schritt darüber, erscheint ein gestrichelter grüner Rahmen.

### 2.2 Mit dem Auswahlfeld oder den Pfeilen

- **↑ / ↓:** verschiebt den Schritt um eine Stelle innerhalb seiner Phase. Am obersten bzw. untersten Schritt ist der Pfeil deaktiviert.
- **„In Phase verschieben“:** setzt den Schritt ans **Ende** der gewählten Phase. Danach kannst du ihn mit ↑/↓ weiter nach oben schieben.

Das Auswahlfeld hat dieselbe Wirkung wie ein Ziehen in eine andere Phase, nur ohne die Stelle zu wählen.

## 3. Bedingungen

| Fall | Was passiert |
| --- | --- |
| **Ohne Recht „Agents verwalten“** | Der Griff ⠿ ist ausgeblendet, das Auswahlfeld „In Phase verschieben“ und ↑/↓ sind nicht sichtbar. Es gibt keine Möglichkeit zu ziehen. |
| **Speichern läuft** | Der Griff ist abgeblendet, Ziehen ist gesperrt. ↑/↓ und das Auswahlfeld sind ebenfalls deaktiviert, bis die Speicherung fertig ist. |
| **Innerhalb einer Phase** | Ein Speichervorgang. Die Positionen der Phase werden ab 1 neu vergeben. |
| **Über eine Phasengrenze** | Zwei Speichervorgänge nacheinander: zuerst die Zielphase mit dem Schritt, danach die Quellphase ohne den Schritt. Die Quellphase bleibt dadurch lückenlos von 1 an nummeriert. |
| **Ablegen an der eigenen Stelle** | Nichts wird gespeichert. |
| **Pausierter Schritt** | Lässt sich ziehen und verschieben. Er bleibt pausiert („Pausiert – läuft hier nicht mit.“). |
| **Agent deaktiviert** | Lässt sich ziehen und verschieben. Er bleibt deaktiviert („Der Agent ist in seinen Einstellungen deaktiviert und läuft hier nicht mit.“). |
| **Touch-Gerät (Tablet, Handy)** | Natives Ziehen funktioniert dort nicht. Nutze das Auswahlfeld oder die Pfeile. |
| **Mehrere Schritte gleichzeitig** | Nicht möglich. Jeder Schritt wird einzeln verschoben. |
| **Agent aus der Agentenliste ziehen** | Nicht möglich. Neue Agents fügst du weiter über „+ Agent“ hinzu. |
| **Verschieben zwischen Projekten** | Nicht möglich. |
| **Laufender Auftrag** | Der Lauf nutzt den Ablauf vom Start. Die neue Reihenfolge gilt ab dem nächsten Lauf (siehe [`benutzerhandbuch-workflow-umbau-waehrend-lauf.md`](benutzerhandbuch-workflow-umbau-waehrend-lauf.md)). |

Erfolgsmeldungen erscheinen oben im Panel und verschwinden nach einer Weile von selbst. Nach dem Ziehen lautet die Meldung „Reihenfolge gespeichert.“. Nach dem Auswahlfeld lautet sie „Schritt nach „<Phase>“ verschoben.“.

## 4. Fehlerbehebung

| Beobachtung | Ursache und was zu tun ist |
| --- | --- |
| Der Schritt springt nach dem Ablegen zurück an seine alte Stelle | Das Speichern ist fehlgeschlagen. Oben steht die Fehlermeldung. Die Anzeige lädt danach den Stand des Servers. Versuche es erneut. |
| Der Griff ⠿ fehlt | Dir fehlt das Recht „Agents verwalten“. Bitte eine Administration um die Rolle. |
| Ziehen geht nicht, obwohl der Griff da ist | Eine Speicherung läuft noch. Warte, bis die Schaltflächen wieder aktiv sind. |
| In der Quellphase fehlt eine Nummer | Das zweite Speichern ist abgebrochen. Die Reihenfolge bleibt richtig, nur die Nummer hat eine Lücke. Ein Neuladen der Seite zeigt den Stand des Servers. Verschiebe den Schritt in der Quellphase einmal mit ↑ oder ↓, dann ist die Nummerierung wieder lückenlos. |
| Ein Schritt ist nach dem Neuladen wieder an der alten Stelle | Die Speicherung ist nicht angekommen. Prüfe die Fehlermeldung und wiederhole das Verschieben. |
| Der Pausierte-Status ist weg | Sollte nicht passieren, das Verschieben ändert den Status nicht. Bitte mit Auftrag und Uhrzeit melden. |

## 5. Grenzen dieses Kapitels

- Die Tests liegen in `frontend/src/app/features/agents/workflow-order.spec.ts` (Berechnung der Reihenfolge), in `src/api/app.test.ts` (Endpunkt) und in `e2e/full-ui.check.ts` (Oberfläche). Ich habe sie in dieser Sitzung nicht ausgeführt.
- Die Beschreibung der Optik (Farben, Schatten, Einfügemarke) stammt aus `14-agents.css`. Ich habe sie nicht im Browser gesehen.
- Der Endpunkt `POST /projects/:slug/workflow/order` wurde nicht geändert. Er setzt `phase` und `position` und lässt `enabled` unberührt.

## 6. Noch aufzunehmen

Diese Aufnahmen fehlen. Sie brauchen eine laufende App mit Testdaten und einem Browser:

1. Workflow-Panel im Ausgangszustand, mit Griffen ⠿ (Benutzer mit Recht „Agents verwalten“).
2. Schritt während des Ziehens: transparenter Eintrag mit Schatten, grüne Einfügemarke, hervorgehobene Zielphase.
3. Schritt über einer leeren Phase: gestrichelter Rahmen.
4. Das Menü eines Schritts mit ↑/↓ und Auswahlfeld „In Phase verschieben“.
5. Panel ohne Recht „Agents verwalten“: keine Griffe und keine Schaltflächen.
6. Fehlermeldung nach einem fehlgeschlagenen Speichern.

## 7. Verweise

- [`agenten-per-drag-and-drop-zwischen-phasen-2026-10-28.md`](agenten-per-drag-and-drop-zwischen-phasen-2026-10-28.md) (Entwicklerdoku zu diesem Auftrag)
- [`benutzerhandbuch-workflow-umbau-waehrend-lauf.md`](benutzerhandbuch-workflow-umbau-waehrend-lauf.md) (Umbau während eines laufenden Auftrags)
- [`workflows.md`](../workflows.md), Abschnitt 4a (Workflow-Editor)
