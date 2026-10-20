# Testbericht 20.10.2026, 22:53:16

Erstellt mit `npm run test:full`. Gesamtergebnis: ✅ alles grün.
Der Oberflächentest läuft auf einer eigenen Testdatenbank (dev_log_full) ohne Worker: Agents, Chat-Antworten und der Projekt-Assistent starten dort nicht.


## Übersicht

| Prüfung | Ergebnis | Dauer | Zusammenfassung |
|---|---|---|---|
| Lint | ✅ | 4 s | 500 problems (0 errors, 500 warnings) |
| Formatierung | ✅ | 4 s | alles formatiert |
| Typprüfung | ✅ | 3 s | Backend und Oberfläche |
| Unit-Tests (inkl. UI-Build) | ✅ | 21 s | 794 bestanden, 0 fehlgeschlagen, 5 Build-Warnungen |
| E2E-Tests | ✅ | 60 s | 48 passed, 2 skipped |
| Oberflächentest | ✅ | 451 s | 19 passed, 9 skipped |

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

🎬 [Video ansehen](media/013-desktop-Alle-Seiten-laden-ohne-Fehler-und-ohne-seitliches-Üb.webm)

### ✅ Tabellen: Sortieren, Filtern, Suchen und Zurücksetzen auf allen Seiten · desktop

Status: passed · Dauer 55.4 s

**Bildschirm am Ende**

![Bildschirm am Ende](media/014-desktop-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/015-desktop-Tabellen-Sortieren-Filtern-Suchen-und-Zurücksetzen-a.webm)

### ✅ Dashboard: Kennzahlen, Links und Agent-Aktionen · desktop

Status: passed · Dauer 1.9 s

**Agent-Aktionen**

![Agent-Aktionen](media/016-desktop-Agent-Aktionen.png)

**Agent-Aktion Verlauf**

![Agent-Aktion Verlauf](media/017-desktop-Agent-Aktion-Verlauf.png)

**Agent-Aktion Zeitplan**

![Agent-Aktion Zeitplan](media/018-desktop-Agent-Aktion-Zeitplan.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/019-desktop-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/020-desktop-Dashboard-Kennzahlen-Links-und-Agent-Aktionen.webm)

### ✅ Auftrag: anlegen, Status ändern, erneut versuchen, analysieren, löschen · desktop

Status: passed · Dauer 1.9 s

**Neuer Auftrag geklickt**

![Neuer Auftrag geklickt](media/021-desktop-Neuer-Auftrag-geklickt.png)

**Auftrag Details**

![Auftrag Details](media/022-desktop-Auftrag-Details.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/023-desktop-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/024-desktop-Auftrag-anlegen-Status-ändern-erneut-versuchen-analy.webm)

### ✅ Ideen: anlegen, öffnen, kommentieren, Auftrag erstellen lassen · desktop

Status: passed · Dauer 1.7 s

**Idee mit Kommentar**

![Idee mit Kommentar](media/025-desktop-Idee-mit-Kommentar.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/026-desktop-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/027-desktop-Ideen-anlegen-öffnen-kommentieren-Auftrag-erstellen-.webm)

### ✅ Bugs: anlegen, Status ändern, bearbeiten, löschen · desktop

Status: passed · Dauer 1.7 s

**Bug bearbeitet**

![Bug bearbeitet](media/028-desktop-Bug-bearbeitet.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/029-desktop-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/030-desktop-Bugs-anlegen-Status-ändern-bearbeiten-löschen.webm)

### ✅ Sprints: Datum prüfen, anlegen, Board öffnen, starten · desktop

Status: passed · Dauer 1.8 s

**Sprint-Board**

![Sprint-Board](media/031-desktop-Sprint-Board.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/032-desktop-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/033-desktop-Sprints-Datum-prüfen-anlegen-Board-öffnen-starten.webm)

### ✅ Dokumentation: Markdown, bearbeiten, einreichen, freigeben, neues Handbuch · desktop

Status: passed · Dauer 1.6 s

**Doku Architektur**

![Doku Architektur](media/034-desktop-Doku-Architektur.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/035-desktop-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/036-desktop-Dokumentation-Markdown-bearbeiten-einreichen-freigeb.webm)

### ✅ Agents: anlegen, Reihenfolge, aktivieren, Detailansicht · desktop

Status: passed · Dauer 1.7 s

**Agent-Detail**

![Agent-Detail](media/037-desktop-Agent-Detail.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/038-desktop-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/039-desktop-Agents-anlegen-Reihenfolge-aktivieren-Detailansicht.webm)

### ✅ Agents: „Was machen die Rollen?“ auf- und zuklappen · desktop

Status: passed · Dauer 1.5 s

**Was machen die Rollen**

![Was machen die Rollen](media/040-desktop-Was-machen-die-Rollen.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/041-desktop-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/042-desktop-Agents-Was-machen-die-Rollen-auf-und-zuklappen.webm)

### ✅ Einstellungen: Validierungen, Benutzer anlegen, Projekt löschen gesperrt · desktop

Status: passed · Dauer 2.3 s

**Einstellungen**

![Einstellungen](media/043-desktop-Einstellungen.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/044-desktop-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/045-desktop-Einstellungen-Validierungen-Benutzer-anlegen-Projekt.webm)

### ✅ Projektwechsel trennt die Daten · desktop

Status: passed · Dauer 1.9 s

**Bildschirm am Ende**

![Bildschirm am Ende](media/046-desktop-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/047-desktop-Projektwechsel-trennt-die-Daten.webm)

### ✅ Rollen: Autorin sieht nur, was sie darf · desktop

Status: passed · Dauer 1.4 s

**Ansicht der Autorin**

![Ansicht der Autorin](media/048-desktop-Ansicht-der-Autorin.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/049-desktop-Bildschirm-am-Ende.png)

### ✅ Jeder Knopf und Link: anklicken, Dialoge bearbeiten und speichern, ohne Fehler · desktop

Status: passed · Dauer 203.3 s

**Klicktest dashboard**

![Klicktest dashboard](media/050-desktop-Klicktest-dashboard.png)

**Klicktest actions**

![Klicktest actions](media/051-desktop-Klicktest-actions.png)

**Klicktest docs**

![Klicktest docs](media/052-desktop-Klicktest-docs.png)

**Klicktest ideation**

![Klicktest ideation](media/053-desktop-Klicktest-ideation.png)

**Klicktest development**

![Klicktest development](media/054-desktop-Klicktest-development.png)

**Klicktest sprints**

![Klicktest sprints](media/055-desktop-Klicktest-sprints.png)

**Klicktest bugs**

![Klicktest bugs](media/056-desktop-Klicktest-bugs.png)

**Klicktest runs**

![Klicktest runs](media/057-desktop-Klicktest-runs.png)

**Klicktest agents**

![Klicktest agents](media/058-desktop-Klicktest-agents.png)

**Klicktest stats**

![Klicktest stats](media/059-desktop-Klicktest-stats.png)

**Klicktest settings**

![Klicktest settings](media/060-desktop-Klicktest-settings.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/061-desktop-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/062-desktop-Jeder-Knopf-und-Link-anklicken-Dialoge-bearbeiten-un.webm)

### ✅ Alle Seiten laden ohne Fehler und ohne seitliches Überlaufen · handy

Status: passed · Dauer 3.5 s

**dashboard (Handy)**

![dashboard (Handy)](media/063-handy-dashboard-Handy.png)

**actions (Handy)**

![actions (Handy)](media/064-handy-actions-Handy.png)

**docs (Handy)**

![docs (Handy)](media/065-handy-docs-Handy.png)

**ideation (Handy)**

![ideation (Handy)](media/066-handy-ideation-Handy.png)

**development (Handy)**

![development (Handy)](media/067-handy-development-Handy.png)

**sprints (Handy)**

![sprints (Handy)](media/068-handy-sprints-Handy.png)

**bugs (Handy)**

![bugs (Handy)](media/069-handy-bugs-Handy.png)

**runs (Handy)**

![runs (Handy)](media/070-handy-runs-Handy.png)

**agents (Handy)**

![agents (Handy)](media/071-handy-agents-Handy.png)

**stats (Handy)**

![stats (Handy)](media/072-handy-stats-Handy.png)

**settings (Handy)**

![settings (Handy)](media/073-handy-settings-Handy.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/074-handy-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/075-handy-Alle-Seiten-laden-ohne-Fehler-und-ohne-seitliches-Über.webm)

### ⏭️ Tabellen: Sortieren, Filtern, Suchen und Zurücksetzen auf allen Seiten · handy

Status: skipped · Dauer 0.2 s

**Bildschirm am Ende**

![Bildschirm am Ende](media/076-handy-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/077-handy-Tabellen-Sortieren-Filtern-Suchen-und-Zurücksetzen-auf.webm)

### ⏭️ Dashboard: Kennzahlen, Links und Agent-Aktionen · handy

Status: skipped · Dauer 0.2 s

**Bildschirm am Ende**

![Bildschirm am Ende](media/078-handy-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/079-handy-Dashboard-Kennzahlen-Links-und-Agent-Aktionen.webm)

### ⏭️ Auftrag: anlegen, Status ändern, erneut versuchen, analysieren, löschen · handy

Status: skipped · Dauer 0.2 s

**Bildschirm am Ende**

![Bildschirm am Ende](media/080-handy-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/081-handy-Auftrag-anlegen-Status-ändern-erneut-versuchen-analysi.webm)

### ⏭️ Ideen: anlegen, öffnen, kommentieren, Auftrag erstellen lassen · handy

Status: skipped · Dauer 0.2 s

**Bildschirm am Ende**

![Bildschirm am Ende](media/082-handy-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/083-handy-Ideen-anlegen-öffnen-kommentieren-Auftrag-erstellen-la.webm)

### ⏭️ Bugs: anlegen, Status ändern, bearbeiten, löschen · handy

Status: skipped · Dauer 0.1 s

**Bildschirm am Ende**

![Bildschirm am Ende](media/084-handy-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/085-handy-Bugs-anlegen-Status-ändern-bearbeiten-löschen.webm)

### ⏭️ Sprints: Datum prüfen, anlegen, Board öffnen, starten · handy

Status: skipped · Dauer 0.1 s

**Bildschirm am Ende**

![Bildschirm am Ende](media/086-handy-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/087-handy-Sprints-Datum-prüfen-anlegen-Board-öffnen-starten.webm)

### ⏭️ Dokumentation: Markdown, bearbeiten, einreichen, freigeben, neues Handbuch · handy

Status: skipped · Dauer 0.1 s

**Bildschirm am Ende**

![Bildschirm am Ende](media/088-handy-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/089-handy-Dokumentation-Markdown-bearbeiten-einreichen-freigeben.webm)

### ⏭️ Agents: anlegen, Reihenfolge, aktivieren, Detailansicht · handy

Status: skipped · Dauer 0.2 s

**Bildschirm am Ende**

![Bildschirm am Ende](media/090-handy-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/091-handy-Agents-anlegen-Reihenfolge-aktivieren-Detailansicht.webm)

### ✅ Agents: „Was machen die Rollen?“ auf- und zuklappen · handy

Status: passed · Dauer 1.6 s

**Was machen die Rollen**

![Was machen die Rollen](media/092-handy-Was-machen-die-Rollen.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/093-handy-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/094-handy-Agents-Was-machen-die-Rollen-auf-und-zuklappen.webm)

### ✅ Einstellungen: Validierungen, Benutzer anlegen, Projekt löschen gesperrt · handy

Status: passed · Dauer 1.6 s

**Projekt löschen (Handy)**

![Projekt löschen (Handy)](media/095-handy-Projekt-löschen-Handy.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/096-handy-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/097-handy-Einstellungen-Validierungen-Benutzer-anlegen-Projekt-l.webm)

### ⏭️ Projektwechsel trennt die Daten · handy

Status: skipped · Dauer 0.1 s

**Bildschirm am Ende**

![Bildschirm am Ende](media/098-handy-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/099-handy-Projektwechsel-trennt-die-Daten.webm)

### ✅ Rollen: Autorin sieht nur, was sie darf · handy

Status: passed · Dauer 1.7 s

**Ansicht der Autorin**

![Ansicht der Autorin](media/100-handy-Ansicht-der-Autorin.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/101-handy-Bildschirm-am-Ende.png)

### ✅ Jeder Knopf und Link: anklicken, Dialoge bearbeiten und speichern, ohne Fehler · handy

Status: passed · Dauer 157.7 s

**Klicktest dashboard (Handy)**

![Klicktest dashboard (Handy)](media/102-handy-Klicktest-dashboard-Handy.png)

**Klicktest actions (Handy)**

![Klicktest actions (Handy)](media/103-handy-Klicktest-actions-Handy.png)

**Klicktest docs (Handy)**

![Klicktest docs (Handy)](media/104-handy-Klicktest-docs-Handy.png)

**Klicktest ideation (Handy)**

![Klicktest ideation (Handy)](media/105-handy-Klicktest-ideation-Handy.png)

**Klicktest development (Handy)**

![Klicktest development (Handy)](media/106-handy-Klicktest-development-Handy.png)

**Klicktest sprints (Handy)**

![Klicktest sprints (Handy)](media/107-handy-Klicktest-sprints-Handy.png)

**Klicktest bugs (Handy)**

![Klicktest bugs (Handy)](media/108-handy-Klicktest-bugs-Handy.png)

**Klicktest runs (Handy)**

![Klicktest runs (Handy)](media/109-handy-Klicktest-runs-Handy.png)

**Klicktest agents (Handy)**

![Klicktest agents (Handy)](media/110-handy-Klicktest-agents-Handy.png)

**Klicktest stats (Handy)**

![Klicktest stats (Handy)](media/111-handy-Klicktest-stats-Handy.png)

**Klicktest settings (Handy)**

![Klicktest settings (Handy)](media/112-handy-Klicktest-settings-Handy.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/113-handy-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/114-handy-Jeder-Knopf-und-Link-anklicken-Dialoge-bearbeiten-und-.webm)

## Ausgabe fehlgeschlagener Prüfungen

