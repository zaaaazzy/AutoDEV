# Benutzerhandbuch: Sprint-Seite mit gesperrten Knöpfen statt 409-Fehlern

Auftrag d923faa6 (Bugfix, Sprint 28, Schwere niedrig). Dieses Kapitel beschreibt, welche Knöpfe im Sprint-Detail bei welchem Zustand klickbar sind, was ausgegraut bleibt und warum. Die Entwicklerdoku steht in [`sprint-seite-keine-409-aktionen-2026-10-29.md`](sprint-seite-keine-409-aktionen-2026-10-29.md).

> **Was sich geändert hat:** Vorher konntest du auf der Sprint-Seite Aktionen anstoßen, die der Server mit 409 ablehnte. „Sprint starten“ und „Wieder öffnen“ erschienen auch bei einem anderen aktiven Sprint. „Live schalten“ erschien auch, solange Aufträge noch liefen. „Löschen“ stand zeitweise bei aktiven oder im Review befindlichen Sprints. Jetzt gilt:
>
> - „Sprint starten“ und „Wieder öffnen“ bleiben sichtbar, sind aber **gesperrt**, solange ein anderer Sprint des Projekts aktiv ist. Der Tooltip nennt den Grund.
> - „Live schalten“ ist **gesperrt**, solange Aufträge laufen oder auf Freigabe warten. Der Tooltip nennt den Grund.
> - „Löschen“ erscheint **nie** bei einem aktiven oder im Review befindlichen Sprint.
>
> **Printscreens:** keine. Die App lief für diesen Auftrag nicht, und ich habe keinen Browser gestartet. Die Bedingungen unten stammen aus dem Code (`frontend/src/app/features/sprints/sprint-actions.ts`, `sprint-detail.component.html`) und aus `src/core/sprint-rules.ts`. Die Tests wurden für dieses Handbuch nicht ausgeführt.

---

## 1. Welche Rolle du brauchst

| Knopf | Rolle | Sonst |
| --- | --- | --- |
| Bearbeiten, Sprint starten, Live schalten, Wieder öffnen, Abbrechen, Wieder planen, Löschen | **Planung** | fehlt ganz |
| Pausieren, Fortsetzen | **Ausführen** | fehlt ganz |

Ohne die passende Rolle erscheint der Knopf nicht. Gesperrt wird nur, was du mit deiner Rolle sehen würdest.

---

## 2. Sichtbar, gesperrt oder weg

| Knopf | Sichtbar, wenn | Gesperrt, wenn | Tooltip bei Sperre |
| --- | --- | --- | --- |
| **Sprint starten** (Sprint ist geplant) | Rolle „Planung“ | ein anderer Sprint des Projekts ist aktiv | „Es kann nur ein Sprint pro Projekt aktiv sein.“ |
| **Wieder öffnen** (Sprint ist abgeschlossen) | Rolle „Planung“ | ein anderer Sprint des Projekts ist aktiv | wie oben |
| **Live schalten** (Sprint ist aktiv) | Rolle „Planung“ | Aufträge sind noch `in_progress` oder warten auf Freigabe | Grund aus der Auftragsliste, z. B. „Im Sprint laufen noch Aufträge.“ |
| **Löschen** | Rolle „Planung“, Sprint ist geplant, abgeschlossen oder abgebrochen, keine Git-Sicherung läuft, keine Aufträge laufen oder warten auf Freigabe | – | – |

Der Knopf **Löschen** fehlt in diesen Fällen ganz, statt ausgegraut zu sein:

- Der Sprint ist **aktiv** oder **im Review**.
- Eine Git-Sicherung des Sprints läuft noch.
- Im Sprint laufen Aufträge oder warten auf Freigabe.

Weitere Knöpfe (Bearbeiten, Pausieren, Fortsetzen, Abbrechen, Wieder planen) bleiben so wie in [`benutzerhandbuch-sprint-knoepfe-nur-wenn-erlaubt-2026-10-28.md`](benutzerhandbuch-sprint-knoepfe-nur-wenn-erlaubt-2026-10-28.md) beschrieben.

---

## 3. Beispiele

**Sprint B ist geplant, Sprint A ist aktiv.** In Sprint B siehst du „Sprint starten“, ausgegraut. Mit der Maus darüber zeigt der Tooltip den Grund. Pausiere, schließe oder breche Sprint A ab, dann ist der Knopf wieder anklickbar.

**Sprint A läuft, ein Auftrag ist `in_progress`.** „Live schalten“ ist ausgegraut. Warte, bis der Auftrag fertig oder in Freigabe ist, und prüfe danach, ob er noch auf Freigabe wartet. Erst wenn beides leer ist, lässt sich der Knopf drücken.

**Sprint A ist aktiv oder im Review.** Es gibt kein „Löschen“. Breche den Sprint ab oder schließe ihn ab, und lösche ihn danach, sofern er geplant, abgeschlossen oder abgebrochen ist.

---

## 4. Was der Server trotzdem prüft

Die Oberfläche zeigt nur an, was gerade erlaubt ist. Der Server prüft jede Anfrage weiterhin selbst. Die Meldungen bleiben gleich:

- **409** „Es kann nur ein Sprint pro Projekt aktiv sein.“ beim Starten und Wieder öffnen.
- **409** „Im Sprint laufen noch Aufträge.“ beim Live schalten.
- **403** bei fehlender Rolle.

Ein 409 bekommst du nur noch, wenn sich der Zustand zwischen Anzeige und Klick geändert hat, etwa weil ein Agent gerade einen Auftrag gestartet hat. Lade die Seite neu, dann stimmen die Knöpfe wieder.

---

## 5. Fehlerbehebung

- **„Sprint starten“ ist ausgegraut.** Ein anderer Sprint des Projekts ist aktiv. Den Tooltip lesen, dann den aktiven Sprint pausieren oder abschließen.
- **„Live schalten“ ist ausgegraut.** Im Sprint laufen noch Aufträge oder einer wartet auf Freigabe. Die Auftragsliste im Sprint zeigt, welcher.
- **„Löschen“ fehlt.** Der Sprint ist aktiv oder im Review, eine Git-Sicherung läuft, oder es hängen Aufträge am Sprint. Siehe Abschnitt 2.
- **Ein Knopf ist gesperrt, obwohl der Grund weg ist.** Die Seite neu laden. Die Anzeige hat sich möglicherweise nicht aktualisiert.

---

## 6. Für Entwickler

- Neue Sperrgründe gehören in `src/core/sprint-rules.ts` bzw. in `sprintButtons()` (`sprint-actions.ts`). Das Template setzt nur `disabled` und `title`.
- Die 409-Meldung „Es kann nur ein Sprint pro Projekt aktiv sein.“ steht als `ONE_ACTIVE_SPRINT_MESSAGE` in `src/core/sprint-rules.ts`. Server und Oberfläche nutzen dieselbe Konstante.
- Tests: `frontend/src/app/features/sprints/sprint-phases.spec.ts` (Regressionstest) und `frontend/src/app/features/sprints/sprint-actions.spec.ts`.

## Offen

- Printscreens fehlen. Sie lassen sich nachholen, wenn die App mit Datenbank und Worker lokal läuft. Vorgesehen: ein geplanter Sprint neben einem aktiven, ein aktiver Sprint mit laufendem Auftrag.
- Die Tests sind für dieses Handbuch nicht ausgeführt worden.
