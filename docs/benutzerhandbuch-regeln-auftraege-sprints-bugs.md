# Benutzerhandbuch: Regeln für Aufträge, Sprints und Bugs

Dieses Kapitel beschreibt, was AIdeation bei Aufträgen, Sprints und Bugs erlaubt und was es ablehnt, und welche Meldung du dann siehst. Es gehört zum Auftrag b8004e48 (25.10.2026, Sprint 23).

> **Was sich geändert hat:** Nichts an der Bedienung. Der Auftrag hat nur Tests ergänzt (`src/api/order-sprint-bug-routes.test.ts`). Die Regeln unten gelten also schon vorher; die Tests sichern sie jetzt gegen einen späteren Umbau ab.
>
> **Printscreens:** keine. Dafür müssten App, Datenbank und Browser laufen; das ist für diesen Auftrag nicht geschehen. Die Feldbezeichnungen in der Oberfläche sind nicht im Browser gegengeprüft.

Die Meldungen stammen aus der Schnittstelle (`src/api/development.ts`, `src/api/sprints.ts`, `src/api/bugs.ts`). Die Erlaubt-/Abgelehnt-Fälle stammen aus der Testtabelle in `docs/api-tests-auftraege-sprints-bugs-2026-10-25.md`.

---

## 1. Auftrag anlegen

| Status beim Anlegen | Ergebnis |
| --- | --- |
| `planned` | Auftrag wird angelegt (201). |
| `in_progress`, `approval`, `done`, `blocked`, `rejected` | 400, es wird nichts angelegt. |

---

## 2. Status eines Auftrags ändern

- **Erlaubt:** `planned` → `backlog`.
- **Abgelehnt:** `done` → `planned` mit 409. Der Auftrag bleibt unverändert.
- Viele Übergänge setzt nur der Worker oder eine eigene Aktion. Ein manueller Versuch endet mit 409 und dem Hinweis „Status change … is not allowed manually; it is set by the worker or a dedicated action.“ Diese Meldung ist derzeit auf Englisch.

---

## 3. Auftrag in einen Sprint nehmen oder herausnehmen

### 3.1 Sprint zuordnen

- Ein Auftrag im Status „in Arbeit“, „in Freigabe“ oder „erledigt“ lässt sich keinem anderen Sprint zuordnen. Meldung: „Aufträge in Arbeit, in Freigabe oder erledigt lassen sich keinem anderen Sprint zuordnen.“ (409)
- Ziel muss ein **geplanter oder aktiver** Sprint sein. Sonst: „Aufträge lassen sich nur geplanten oder aktiven Sprints zuordnen.“ (409)
- Der Sprint muss zum Projekt des Auftrags gehören. Sonst: „Der Sprint gehört nicht zum Projekt dieses Auftrags.“ (400)

### 3.2 Übernehmen („Aufträge hinzufügen“)

- **Erlaubt:** offene oder abgebrochene Aufträge ohne Sprint, Ziel ist ein geplanter oder aktiver Sprint desselben Projekts.
- Ein abgebrochener Auftrag (aus einem Sprint genommen oder blockiert) wird dabei zurückgesetzt. Ein blockierter Auftrag zählt zusätzlich einen Versuch hoch.
- Läuft der Ziel-Sprint bereits, startet der Auftrag automatisch. Ist der Sprint nur geplant, wartet er auf den Start.
- **Abgelehnt:** Express-Aufträge, Aufträge mit Sprint oder Ziel außerhalb des Projekts. Meldung: „Nur offene oder abgebrochene Aufträge ohne Sprint lassen sich übernehmen, und nur in geplante oder aktive Sprints desselben Projekts.“ (409)

### 3.3 Aus dem Sprint nehmen

- **Erlaubt:** geplante oder blockierte Aufträge, und nur aus geplanten oder aktiven Sprints.
- **Geplanter Sprint:** Der Auftrag geht ohne Vermerk ins Backlog.
- **Aktiver Sprint:** Der Auftrag bekommt einen Vermerk und wartet unter „Aktionen“ auf eine Entscheidung.
- **Abgelehnt:** laufende Aufträge und Aufträge im abgeschlossenen oder abgebrochenen Sprint. Meldung: „Nur geplante oder blockierte Aufträge lassen sich herausnehmen, und nur aus geplanten oder aktiven Sprints.“ (409)

### 3.4 Erneut versuchen („Wieder einplanen“)

- **Erlaubt:** blockierte, abgelehnte oder aus dem Sprint genommene Aufträge, wenn das Ziel ein geplanter oder aktiver Sprint desselben Projekts ist.
- Bei einem **abgelehnten Bug-Auftrag** wird der Auftrag wieder `planned`, und der Bug springt zurück auf „offen“.
- Bei einem **blockierten Auftrag** zählt der Versuch hoch.
- **Abgelehnt:**
  - Ziel ist kein geplanter oder aktiver Sprint: „Erneut versuchen nur in geplante oder aktive Sprints desselben Projekts.“ (409)
  - Auftrag ist weder blockiert, abgelehnt noch aus dem Sprint genommen, oder ist ein Express-Auftrag: „Nur blockierte, abgelehnte oder aus dem Sprint genommene Aufträge können weiterbearbeitet werden. Express-Anfragen gehen im Dashboard-Chat weiter.“ (409)
- Ein zweiter Versuch auf einen bereits wieder eingeplanten Auftrag ändert nichts am Bug.

### 3.5 Freigabe ablehnen (review-reject)

- **Erlaubt:** Freigabe zurückgewiesen, mit Rückmeldung. Der Auftrag geht auf `planned`, die Rückmeldung steht in der Beschreibung, ein Bug geht von „in Arbeit“ auf „offen“.
- **Abgelehnt:** ohne Kommentar (400). Ein Auftrag, der schon freigegeben ist oder gerade „in Arbeit“ steht (409).

### 3.6 Folgeauftrag

- **Erlaubt:** neuer Auftrag zu einem **erledigten** Auftrag, in einen geplanten oder aktiven Sprint desselben Projekts.
- **Abgelehnt:**
  - Quelle nicht erledigt: „Ein Folgeauftrag bezieht sich auf einen erledigten Auftrag.“ (400)
  - Quelle nicht gefunden: „Auftrag nicht gefunden.“ (404)
  - Sprint gehört zu einem anderen Projekt: „Sprint gehört nicht zum Projekt.“ (400)
  - Leerer Titel: Hinweis zu Titel und Beschreibung (400)
  - Sprint abgebrochen oder abgeschlossen: „Folgeaufträge nur in geplante oder aktive Sprints.“ (409)

---

## 4. Sprint-Status ändern

Erlaubte Wechsel per Oberfläche oder Schnittstelle:

| Von | Nach | Ergebnis |
| --- | --- | --- |
| geplant | aktiv | Start. Ohne sauberen Agent-Ordner wird der Start abgelehnt. |
| geplant | abgebrochen | Abbruch (siehe 4.3). |
| aktiv | geplant | Zurück in die Planung. |
| aktiv | abgeschlossen | Abschluss (siehe 4.1). |
| aktiv | abgebrochen | Abbruch (siehe 4.3). |
| abgeschlossen | aktiv | „Wieder öffnen“, ohne neue Git-Sicherung. |
| abgebrochen | geplant | Wieder planen. |

**Abgelehnt** mit 409 „Statuswechsel … ist für Sprints nicht erlaubt.“ sind zum Beispiel: abgebrochen → aktiv, abgeschlossen → geplant.

### 4.1 Sprint abschließen

- **Erlaubt:** nur, wenn kein Auftrag mehr läuft und keiner auf Freigabe wartet. Der Bericht wird erstellt, die Git-Sicherung steht danach auf „ausstehend“.
- **Abgelehnt** (409, es wird weder abgeschlossen noch synchronisiert):
  - Im Sprint laufen noch Aufträge: „Im Sprint laufen noch Aufträge – erst abwarten oder stoppen, dann abschließen.“
  - Aufträge warten auf Freigabe oder Merge: Die Meldung nennt die Anzahl. Erst freigeben oder zurückweisen und den Merge abwarten.
  - Sprint ist im Review: „Der Sprint ist im Review: Merge und Abschluss folgen nach grüner CI im Pull Request.“
- Ein abgeschlossener Sprint bleibt bei Namens- oder Zieländerungen unberührt. Es wird kein zweiter Bericht und kein zweiter Git-Sync ausgelöst.

### 4.2 Sprint wieder öffnen

- **Erlaubt:** abgeschlossen → aktiv (ohne Git-Sicherung), abgebrochen → geplant.
- **Abgelehnt:** abgebrochen → aktiv (409, nur über „Wieder planen“ und danach „Starten“). Abgeschlossen → geplant (409).
- Pro Projekt kann nur ein Sprint aktiv sein. Ein zweiter aktiver Sprint: „Es kann nur ein Sprint pro Projekt aktiv sein.“ (409)

### 4.3 Sprint abbrechen

- Laufende Agents dieses Sprints werden angehalten. Sie beenden ihren Schritt.
- Offene Aufträge (geplant oder in Freigabe) gehen zurück ins Backlog und bekommen den Vermerk „aus dem Sprint genommen“. Sie erscheinen unter „Aktionen“ und lassen sich für den nächsten Sprint wählen.
- Erledigte und abgelehnte Aufträge bleiben beim Sprint.
- Eine laufende Pause ist mit dem Abbruch beendet.
- Es gibt keine Git-Sicherung und keinen Merge.
- Die Arbeit auf dem Auftrags-Branch bleibt erhalten. Der nächste Lauf setzt dort fort.

### 4.4 Sprint löschen

- **Erlaubt:** geplant, abgeschlossen oder abgebrochen, ohne laufende Git-Sicherung und ohne Aufträge, die laufen oder auf Freigabe warten.
- Geplante Aufträge eines gelöschten Sprints gehen ins Backlog. Einzeln gestartete Aufträge behalten ihren Status.
- **Abgelehnt** (409): aktive Sprints, Sprints mit Aufträgen in Freigabe oder laufender Git-Sicherung. Meldung: „Nur geplante, abgeschlossene oder abgebrochene Sprints ohne Git-Sicherung und ohne Aufträge, die laufen oder auf Freigabe warten, lassen sich löschen.“ Die Aufträge bleiben unverändert.

### 4.5 Name eines Sprints

- Zwei Sprints eines Projekts dürfen nicht denselben Git-Branch bekommen. „Sprint 5“ und „sprint-5“ gelten als gleich.
- Meldung: „Ein anderer Sprint dieses Projekts hat schon einen gleichwertigen Namen (gleicher Git-Branch) – bitte anders benennen.“ (409)

---

## 5. Bugs und ihre Sprints

### 5.1 Bug anlegen

- **Mit aktivem oder geplantem Sprint:** Der Bug entsteht, und es entsteht ein Auftrag im Sprint.
- **Mit abgeschlossenem, abgebrochenem oder im Review befindlichem Sprint:** 409, es entsteht kein Bug. Meldung: „Der Sprint ist nicht mehr zuordenbar. Bugs nur geplanten oder aktiven Sprints zuordnen.“
- Jede Quelle (`manual`, `agent`, `test`, `production`, `github`, `routine`) wird gleich behandelt.

### 5.2 Bug einem Sprint zuordnen

- Gleiche Regel wie bei 5.1: nur geplante oder aktive Sprints des eigenen Projekts. Sonst 400 „Sprint gehört zu einem anderen Projekt.“ oder 409 wie oben.
- Ein Bug aus Betrieb oder GitHub braucht eine Freigabe, bevor sein Auftrag startet.

### 5.3 Bug freigeben

- **Erlaubt:** nur offene Bugs aus Betrieb oder GitHub.
- **Abgelehnt:**
  - „Nur Bugs aus Betrieb oder GitHub brauchen eine Freigabe.“ (400)
  - „Nur offene Bugs können freigegeben werden.“ (409)
  - „Bug ist bereits freigegeben.“ (409)
  - „Bug wurde inzwischen geändert oder schon freigegeben.“ (409), wenn sich der Bug zwischen Anzeige und Klick geändert hat. Die Seite neu laden.

---

## 6. Bekannte Lücken

Diese Punkte sind bestätigt, aber noch nicht behoben. Sie stehen auch in `docs/api-tests-auftraege-sprints-bugs-2026-10-25.md` unter „Nicht abgedeckt“.

- **Laufender Bug-Auftrag wandert mit:** Ändert man den Sprint eines Bugs, hängt sich ein Auftrag im Status „in Arbeit“ an den neuen Sprint. Der Fix liegt auf einem eigenen Zweig (172c4f29).
- **Auftrag in abgeschlossenem Sprint:** Ändert man den Titel eines Bugs in einem abgeschlossenen Sprint, legt AIdeation einen geplanten Auftrag in diesem Sprint an. Der Worker nimmt ihn nie auf. Ein eigener Auftrag soll das klären; einen Umgehungsweg gibt es nicht dokumentiert.

---

## 7. Fehlerbehebung

| Beobachtung | Ursache und was zu tun ist |
| --- | --- |
| Auftrag lässt sich keinem Sprint zuordnen (409) | Der Auftrag läuft, wartet auf Freigabe oder ist erledigt, oder der Sprint ist nicht geplant bzw. aktiv. |
| „Wieder einplanen“ schlägt fehl (409) | Der Auftrag ist nicht blockiert, abgelehnt oder aus dem Sprint genommen, oder der Sprint ist abgeschlossen bzw. abgebrochen. Den Ziel-Sprint wählen oder den Sprint wieder öffnen. |
| Sprint lässt sich nicht abschließen (409) | Ein Auftrag läuft oder wartet auf Freigabe. Abwarten, freigeben oder zurückweisen. |
| Sprint lässt sich nicht löschen (409) | Der Sprint ist aktiv, hat Aufträge in Freigabe oder läuft in der Git-Sicherung. Erst abschließen oder abbrechen, dann löschen. |
| Name des Sprints wird abgelehnt (409) | Ein anderer Sprint des Projekts hat denselben Git-Branch. Anderen Namen wählen. |
| Bug lässt sich nicht freigeben (409) | Der Bug ist schon freigegeben oder nicht offen. Die Liste neu laden. |

---

## 8. Grenzen dieses Kapitels

- Die Erlaubt- und Abgelehnt-Fälle sind durch den Testlauf des Entwicklers belegt (1526 von 1526 Tests grün, 0 übersprungen). Der Tester hat sie noch nicht unabhängig ausgeführt.
- Die Meldungen sind aus dem Code gelesen, nicht im Browser gesehen.
- Die Schnittstelle nutzt für einen Fall eine englische Meldung (siehe Abschnitt 2). Das ist ein Hinweis für den Entwickler, kein Verhalten, auf das du dich verlassen solltest.
