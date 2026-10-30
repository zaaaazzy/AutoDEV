# Benutzerhandbuch: Aufträge hinzufügen – abgebrochene Aufträge nur mit „Agents ausführen“

Auftrag 65ecb969 (Bugfix, Sprint 23). Dieses Kapitel beschreibt, welche Aufträge du im Sprint-Detail unter „Aufträge hinzufügen“ auswählen kannst, mit welcher Rolle und was passiert, wenn du sie übernimmst.

> **Was sich geändert hat:** Vorher konntest du auch abgebrochene Aufträge (blockiert oder aus einem Sprint genommen) mit der Rolle „Planung“ in den Sprint nehmen. Dabei kam beim Server ein Fehler, weil das Neueinplanen die Rolle „Agents ausführen“ braucht. Jetzt sind abgebrochene Aufträge ohne „Agents ausführen“ nicht mehr auswählbar, und die Oberfläche sagt dir, warum. Offene Aufträge bleiben wie bisher mit „Planung“ übernehmbar.
>
> **Printscreens:** keine. Die App lief für diesen Auftrag nicht, und ich habe keinen Browser gestartet. Die Bedingungen unten stammen aus dem Code (`frontend/src/app/features/sprints/sprint-orders.component.ts` und `.html`, `pool-selection.ts`, `sprint-phases.ts`) und aus der Schnittstelle (`src/api/development.ts`, Route `take-into-sprint`). Die Tests wurden für dieses Handbuch nicht ausgeführt.

Die Regeln zu „Aufträge hinzufügen“ stehen auch in [`benutzerhandbuch-regeln-auftraege-sprints-bugs.md`](benutzerhandbuch-regeln-auftraege-sprints-bugs.md), Abschnitt 3.2. Die Rechte der Sprint-Knöpfe stehen in [`benutzerhandbuch-sprint-knoepfe-nur-wenn-erlaubt-2026-10-28.md`](benutzerhandbuch-sprint-knoepfe-nur-wenn-erlaubt-2026-10-28.md).

---

## 1. Welche Rolle du brauchst

| Was du tust | Rolle | Sonst |
| --- | --- | --- |
| Den Bereich „Aufträge hinzufügen“ sehen und offene Aufträge übernehmen | **Planung** | Der Bereich fehlt. |
| Abgebrochene Aufträge übernehmen (neu einplanen) | **Planung** und **Agents ausführen** | Die Aufträge sind nicht auswählbar. |

„Agents ausführen“ ist die Rolle, die auch `/retry` („Erneut versuchen“) braucht. Mit nur „Planung“ siehst du abgebrochene Aufträge in der Liste, kannst sie aber nicht anhaken.

---

## 2. Wann der Bereich erscheint

Der Bereich „Aufträge hinzufügen“ steht unter der Auftragsliste im Sprint-Detail, wenn

- du die Rolle „Planung“ hast, und
- der Sprint **geplant** oder **aktiv** ist.

Im abgeschlossenen, abgebrochenen oder im Review befindlichen Sprint fehlt er. Dort lassen sich keine Aufträge mehr zuordnen.

Der Bereich ist offen, wenn der Sprint keine Aufträge hat. Sonst ist er zu. Du kannst ihn jederzeit mit der Überschrift öffnen und schließen. Eine von dir geöffnete Liste bleibt offen, auch wenn sich die Auftragsliste im Hintergrund aktualisiert.

---

## 3. Welche Aufträge zur Auswahl stehen

Zur Auswahl stehen Aufträge, die **noch in keinem Sprint** sind, und zwar in zwei Gruppen:

| Gruppe | Herkunft-Spalte | Wählbar mit „Planung“ | Wählbar mit „Planung“ und „Agents ausführen“ |
| --- | --- | --- | --- |
| Offene Aufträge | „Offen – noch in keinem Sprint“ | ja | ja |
| Abgebrochene Aufträge | „Abgebrochen“ | **nein** | ja |

**Abgebrochen** heißt: Der Auftrag wurde aus einem Sprint genommen oder ist blockiert.

Nicht zur Auswahl stehen Aufträge, die **laufen**, **auf Freigabe warten** oder **erledigt** sind. Der Server lehnt sie ab (siehe Abschnitt 5).

---

## 4. Was du siehst, wenn du „Agents ausführen“ nicht hast

- Die abgebrochenen Aufträge bleiben in der Liste, haben aber **kein Häkchen**.
- Der Knopf **→** neben einem abgebrochenen Auftrag ist **deaktiviert**. Der Tooltip nennt das fehlende Recht.
- Über der Liste steht der Hinweis: „Abgebrochene Aufträge neu einplanen braucht die Rolle „Agents ausführen“.“

Offene Aufträge lassen sich davon nicht beeinflussen. Du kannst sie weiterhin anhaken und mit „→ In den Sprint“ übernehmen.

### 4.1 Auswahl bei Rollenwechsel

Hast du schon abgebrochene Aufträge angehakt und verlierst dann die Rolle „Agents ausführen“, fallen sie aus der Auswahl. Die Liste zeigt sie danach ohne Häkchen. Die Anzahl oben im Auswahlbalken stimmt damit wieder.

---

## 5. Was der Server prüft

Die Oberfläche zeigt nur, was erlaubt ist. Der Server prüft jede Übernahme selbst, und zwar atomar: Das Zurücksetzen des Auftrags und die Rechteprüfung passieren in einem Schritt. Ohne „Agents ausführen“ wird ein abgebrochener Auftrag nicht verändert.

| Fall | Antwort | Meldung |
| --- | --- | --- |
| Abgebrochener Auftrag ohne „Agents ausführen“ | **403** | „Abgebrochene Aufträge neu einplanen braucht die Rolle „Agents ausführen“.“ |
| Offener Auftrag mit „Planung“ | wird übernommen | – |
| Auftrag läuft, wartet auf Freigabe oder ist erledigt | **409** | „Aufträge in Arbeit, in Freigabe oder erledigt lassen sich keinem anderen Sprint zuordnen.“ |
| Sprint ist nicht geplant oder aktiv | **409** | „Aufträge lassen sich nur geplanten oder aktiven Sprints zuordnen.“ |

Bei mehreren angehakten Aufträgen laufen die übrigen weiter, wenn einer scheitert. Danach zeigt die Meldung, was nicht übernommen wurde, zum Beispiel: „2 von 3 im Sprint – nicht übernommen: Titel X.“

Läuft der Sprint schon, startet der übernommene Auftrag automatisch. Ist der Sprint nur geplant, wartet er auf den Start des Sprints.

---

## 6. Fehlerbehebung

| Beobachtung | Ursache und was zu tun ist |
| --- | --- |
| Ein abgebrochener Auftrag hat kein Häkchen | Dir fehlt die Rolle „Agents ausführen“. Frag jemanden mit dieser Rolle, oder lass dir die Rolle geben. |
| Der Bereich „Aufträge hinzufügen“ fehlt | Dir fehlt die Rolle „Planung“, oder der Sprint ist abgeschlossen, abgebrochen oder im Review. |
| Ein Auftrag fehlt in der Liste | Er läuft, wartet auf Freigabe, ist erledigt oder gehört schon zu einem anderen Sprint. |
| Übernahme meldet „nicht übernommen“ | Der Auftrag ist in der Zwischenzeit gestartet oder einem Sprint zugeordnet worden. Die Liste neu laden. |

---

## 7. Für Entwickler

- Die Rechteregel für die Auswahl steht in `frontend/src/app/features/sprints/pool-selection.ts` (`poolSelectable`, `NEEDS_RUN`).
- Die Server-Prüfung steht in der Route `take-into-sprint` in `src/api/development.ts`. Sie muss zusammen mit der Oberfläche geändert werden. Ändert sich die Rechteregel von `/retry`, zieht `take-into-sprint` mit.
- Tests: `src/api/development-status.test.ts` (`take-into-sprint` mit „Planung“ ohne „Agents ausführen“, offen und abgebrochen) und `frontend/src/app/features/sprints/pool-selection.spec.ts` (Sperre, gemischte Auswahl, Rollenwechsel).
- Technische Beschreibung: `docs/laufzeit.md`, Abschnitt „Aufträge hinzufügen“.

---

## Offen

- Printscreens fehlen. Sie lassen sich nachholen, wenn die App lokal läuft: den Bereich „Aufträge hinzufügen“ einmal mit Rolle „Planung“ und einmal mit beiden Rollen zeigen.
- Die Tests für dieses Kapitel sind nicht erneut ausgeführt worden.
