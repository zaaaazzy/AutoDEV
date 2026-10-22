# Testbericht 21.10.2026, 20:42:41

Erstellt mit `npm run test:full`. Gesamtergebnis: ✅ alles grün.
Der Oberflächentest läuft auf einer eigenen Testdatenbank (dev_log_full) ohne Worker: Agents, Chat-Antworten und der Projekt-Assistent starten dort nicht.


## Übersicht

| Prüfung | Ergebnis | Dauer | Zusammenfassung |
|---|---|---|---|
| Lint | ✅ | 3 s | 506 problems (0 errors, 506 warnings) |
| Formatierung | ✅ | 4 s | alles formatiert |
| Typprüfung | ✅ | 3 s | Backend und Oberfläche |
| Unit-Tests (inkl. UI-Build) | ✅ | 21 s | 821 bestanden, 0 fehlgeschlagen, 6 Build-Warnungen |
| E2E-Tests | ✅ | 60 s | 50 passed, 2 skipped |
| Oberflächentest | ✅ | 233 s | 19 passed, 9 skipped |

## Befunde des Oberflächentests

Keine Befunde.

## Oberflächentest im Detail

### ✅ Alle Seiten laden ohne Fehler und ohne seitliches Überlaufen · desktop

Status: passed · Dauer 2.2 s

**dashboard**

![dashboard](media/001-desktop-dashboard.png)

**actions**

![actions](media/002-desktop-actions.png)

**docs**

![docs](media/003-desktop-docs.png)

**ideation**

![ideation](media/004-desktop-ideation.png)

**development**

![development](media/005-desktop-development.png)

**sprints**

![sprints](media/006-desktop-sprints.png)

**bugs**

![bugs](media/007-desktop-bugs.png)

**runs**

![runs](media/008-desktop-runs.png)

**agents**

![agents](media/009-desktop-agents.png)

**stats**

![stats](media/010-desktop-stats.png)

**settings**

![settings](media/011-desktop-settings.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/012-desktop-Bildschirm-am-Ende.png)

### ✅ Tabellen: Sortieren, Filtern, Suchen und Zurücksetzen auf allen Seiten · desktop

Status: passed · Dauer 59.1 s

**Bildschirm am Ende**

![Bildschirm am Ende](media/013-desktop-Bildschirm-am-Ende.png)

### ✅ Dashboard: Kennzahlen, Links und Agent-Aktionen · desktop

Status: passed · Dauer 1.9 s

**Agent-Aktionen**

![Agent-Aktionen](media/014-desktop-Agent-Aktionen.png)

**Agent-Aktion Verlauf**

![Agent-Aktion Verlauf](media/015-desktop-Agent-Aktion-Verlauf.png)

**Agent-Aktion Zeitplan**

![Agent-Aktion Zeitplan](media/016-desktop-Agent-Aktion-Zeitplan.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/017-desktop-Bildschirm-am-Ende.png)

### ✅ Auftrag: anlegen, Status ändern, erneut versuchen, analysieren, löschen · desktop

Status: passed · Dauer 1.9 s

**Neuer Auftrag geklickt**

![Neuer Auftrag geklickt](media/018-desktop-Neuer-Auftrag-geklickt.png)

**Auftrag Details**

![Auftrag Details](media/019-desktop-Auftrag-Details.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/020-desktop-Bildschirm-am-Ende.png)

### ✅ Ideen: anlegen, öffnen, kommentieren, Auftrag erstellen lassen · desktop

Status: passed · Dauer 1.7 s

**Idee mit Kommentar**

![Idee mit Kommentar](media/021-desktop-Idee-mit-Kommentar.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/022-desktop-Bildschirm-am-Ende.png)

### ✅ Bugs: anlegen, Status ändern, bearbeiten, löschen · desktop

Status: passed · Dauer 1.7 s

**Bug bearbeitet**

![Bug bearbeitet](media/023-desktop-Bug-bearbeitet.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/024-desktop-Bildschirm-am-Ende.png)

### ✅ Sprints: Datum prüfen, anlegen, Aufträge zeigen, starten · desktop

Status: passed · Dauer 1.8 s

**Sprint-Aufträge**

![Sprint-Aufträge](media/025-desktop-Sprint-Aufträge.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/026-desktop-Bildschirm-am-Ende.png)

### ✅ Dokumentation: Markdown, bearbeiten, einreichen, freigeben, neues Handbuch · desktop

Status: passed · Dauer 1.6 s

**Doku Architektur**

![Doku Architektur](media/027-desktop-Doku-Architektur.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/028-desktop-Bildschirm-am-Ende.png)

### ✅ Agents: anlegen, Reihenfolge, aktivieren, Detailansicht · desktop

Status: passed · Dauer 1.7 s

**Agent-Detail**

![Agent-Detail](media/029-desktop-Agent-Detail.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/030-desktop-Bildschirm-am-Ende.png)

### ✅ Agents: „Was machen die Rollen?“ auf- und zuklappen · desktop

Status: passed · Dauer 1.4 s

**Was machen die Rollen**

![Was machen die Rollen](media/031-desktop-Was-machen-die-Rollen.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/032-desktop-Bildschirm-am-Ende.png)

### ✅ Einstellungen: Validierungen, Benutzer anlegen, Projekt löschen gesperrt · desktop

Status: passed · Dauer 2.2 s

**Einstellungen**

![Einstellungen](media/033-desktop-Einstellungen.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/034-desktop-Bildschirm-am-Ende.png)

### ✅ Projektwechsel trennt die Daten · desktop

Status: passed · Dauer 1.7 s

**Bildschirm am Ende**

![Bildschirm am Ende](media/035-desktop-Bildschirm-am-Ende.png)

### ✅ Rollen: Autorin sieht nur, was sie darf · desktop

Status: passed · Dauer 1.4 s

**Ansicht der Autorin**

![Ansicht der Autorin](media/036-desktop-Ansicht-der-Autorin.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/037-desktop-Bildschirm-am-Ende.png)

### ✅ Jeder Knopf und Link: anklicken, Dialoge bearbeiten und speichern, ohne Fehler · desktop

Status: passed · Dauer 77.4 s

**Klicktest dashboard**

![Klicktest dashboard](media/038-desktop-Klicktest-dashboard.png)

**Klicktest actions**

![Klicktest actions](media/039-desktop-Klicktest-actions.png)

**Klicktest docs**

![Klicktest docs](media/040-desktop-Klicktest-docs.png)

**Klicktest ideation**

![Klicktest ideation](media/041-desktop-Klicktest-ideation.png)

**Klicktest development**

![Klicktest development](media/042-desktop-Klicktest-development.png)

**Klicktest sprints**

![Klicktest sprints](media/043-desktop-Klicktest-sprints.png)

**Klicktest bugs**

![Klicktest bugs](media/044-desktop-Klicktest-bugs.png)

**Klicktest runs**

![Klicktest runs](media/045-desktop-Klicktest-runs.png)

**Klicktest agents**

![Klicktest agents](media/046-desktop-Klicktest-agents.png)

**Klicktest stats**

![Klicktest stats](media/047-desktop-Klicktest-stats.png)

**Klicktest settings**

![Klicktest settings](media/048-desktop-Klicktest-settings.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/049-desktop-Bildschirm-am-Ende.png)

### ✅ Alle Seiten laden ohne Fehler und ohne seitliches Überlaufen · handy

Status: passed · Dauer 3.5 s

**dashboard (Handy)**

![dashboard (Handy)](media/050-handy-dashboard-Handy.png)

**actions (Handy)**

![actions (Handy)](media/051-handy-actions-Handy.png)

**docs (Handy)**

![docs (Handy)](media/052-handy-docs-Handy.png)

**ideation (Handy)**

![ideation (Handy)](media/053-handy-ideation-Handy.png)

**development (Handy)**

![development (Handy)](media/054-handy-development-Handy.png)

**sprints (Handy)**

![sprints (Handy)](media/055-handy-sprints-Handy.png)

**bugs (Handy)**

![bugs (Handy)](media/056-handy-bugs-Handy.png)

**runs (Handy)**

![runs (Handy)](media/057-handy-runs-Handy.png)

**agents (Handy)**

![agents (Handy)](media/058-handy-agents-Handy.png)

**stats (Handy)**

![stats (Handy)](media/059-handy-stats-Handy.png)

**settings (Handy)**

![settings (Handy)](media/060-handy-settings-Handy.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/061-handy-Bildschirm-am-Ende.png)

### ⏭️ Tabellen: Sortieren, Filtern, Suchen und Zurücksetzen auf allen Seiten · handy

Status: skipped · Dauer 0.1 s

**Bildschirm am Ende**

![Bildschirm am Ende](media/062-handy-Bildschirm-am-Ende.png)

### ⏭️ Dashboard: Kennzahlen, Links und Agent-Aktionen · handy

Status: skipped · Dauer 0.2 s

**Bildschirm am Ende**

![Bildschirm am Ende](media/063-handy-Bildschirm-am-Ende.png)

### ⏭️ Auftrag: anlegen, Status ändern, erneut versuchen, analysieren, löschen · handy

Status: skipped · Dauer 0.1 s

**Bildschirm am Ende**

![Bildschirm am Ende](media/064-handy-Bildschirm-am-Ende.png)

### ⏭️ Ideen: anlegen, öffnen, kommentieren, Auftrag erstellen lassen · handy

Status: skipped · Dauer 0.1 s

**Bildschirm am Ende**

![Bildschirm am Ende](media/065-handy-Bildschirm-am-Ende.png)

### ⏭️ Bugs: anlegen, Status ändern, bearbeiten, löschen · handy

Status: skipped · Dauer 0.1 s

**Bildschirm am Ende**

![Bildschirm am Ende](media/066-handy-Bildschirm-am-Ende.png)

### ⏭️ Sprints: Datum prüfen, anlegen, Aufträge zeigen, starten · handy

Status: skipped · Dauer 0.2 s

**Bildschirm am Ende**

![Bildschirm am Ende](media/067-handy-Bildschirm-am-Ende.png)

### ⏭️ Dokumentation: Markdown, bearbeiten, einreichen, freigeben, neues Handbuch · handy

Status: skipped · Dauer 0.2 s

**Bildschirm am Ende**

![Bildschirm am Ende](media/068-handy-Bildschirm-am-Ende.png)

### ⏭️ Agents: anlegen, Reihenfolge, aktivieren, Detailansicht · handy

Status: skipped · Dauer 0.2 s

**Bildschirm am Ende**

![Bildschirm am Ende](media/069-handy-Bildschirm-am-Ende.png)

### ✅ Agents: „Was machen die Rollen?“ auf- und zuklappen · handy

Status: passed · Dauer 1.6 s

**Was machen die Rollen**

![Was machen die Rollen](media/070-handy-Was-machen-die-Rollen.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/071-handy-Bildschirm-am-Ende.png)

### ✅ Einstellungen: Validierungen, Benutzer anlegen, Projekt löschen gesperrt · handy

Status: passed · Dauer 1.5 s

**Projekt löschen (Handy)**

![Projekt löschen (Handy)](media/072-handy-Projekt-löschen-Handy.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/073-handy-Bildschirm-am-Ende.png)

### ⏭️ Projektwechsel trennt die Daten · handy

Status: skipped · Dauer 0.1 s

**Bildschirm am Ende**

![Bildschirm am Ende](media/074-handy-Bildschirm-am-Ende.png)

### ✅ Rollen: Autorin sieht nur, was sie darf · handy

Status: passed · Dauer 1.4 s

**Ansicht der Autorin**

![Ansicht der Autorin](media/075-handy-Ansicht-der-Autorin.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/076-handy-Bildschirm-am-Ende.png)

### ✅ Jeder Knopf und Link: anklicken, Dialoge bearbeiten und speichern, ohne Fehler · handy

Status: passed · Dauer 62.5 s

**Klicktest dashboard (Handy)**

![Klicktest dashboard (Handy)](media/077-handy-Klicktest-dashboard-Handy.png)

**Klicktest actions (Handy)**

![Klicktest actions (Handy)](media/078-handy-Klicktest-actions-Handy.png)

**Klicktest docs (Handy)**

![Klicktest docs (Handy)](media/079-handy-Klicktest-docs-Handy.png)

**Klicktest ideation (Handy)**

![Klicktest ideation (Handy)](media/080-handy-Klicktest-ideation-Handy.png)

**Klicktest development (Handy)**

![Klicktest development (Handy)](media/081-handy-Klicktest-development-Handy.png)

**Klicktest sprints (Handy)**

![Klicktest sprints (Handy)](media/082-handy-Klicktest-sprints-Handy.png)

**Klicktest bugs (Handy)**

![Klicktest bugs (Handy)](media/083-handy-Klicktest-bugs-Handy.png)

**Klicktest runs (Handy)**

![Klicktest runs (Handy)](media/084-handy-Klicktest-runs-Handy.png)

**Klicktest agents (Handy)**

![Klicktest agents (Handy)](media/085-handy-Klicktest-agents-Handy.png)

**Klicktest stats (Handy)**

![Klicktest stats (Handy)](media/086-handy-Klicktest-stats-Handy.png)

**Klicktest settings (Handy)**

![Klicktest settings (Handy)](media/087-handy-Klicktest-settings-Handy.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/088-handy-Bildschirm-am-Ende.png)

## Ausgabe fehlgeschlagener Prüfungen

