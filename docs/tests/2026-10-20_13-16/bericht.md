# Testbericht 20.10.2026, 13:16:59

Erstellt mit `npm run test:full`. Gesamtergebnis: ✅ alles grün.
Der Oberflächentest läuft auf einer eigenen Testdatenbank (dev_log_full) ohne Worker: Agents, Chat-Antworten und der Projekt-Assistent starten dort nicht.
In AIdeation abgelegt: Projekt `dev-log`, Testlauf `f15f8d3b-dad1-4e53-a860-e93c8dfdae51`.

## Übersicht

| Prüfung | Ergebnis | Dauer | Zusammenfassung |
|---|---|---|---|
| Lint | ✅ | 3 s | 374 problems (0 errors, 374 warnings) |
| Formatierung | ✅ | 4 s | alles formatiert |
| Typprüfung | ✅ | 3 s | Backend und Oberfläche |
| Unit-Tests (inkl. UI-Build) | ✅ | 19 s | 429 bestanden, 0 fehlgeschlagen, 5 Build-Warnungen |
| E2E-Tests | ✅ | 68 s | 46 passed, 2 skipped |
| Oberflächentest | ✅ | 497 s | 17 passed, 9 skipped |

## Befunde des Oberflächentests

Keine Befunde.

## Oberflächentest im Detail

### ✅ Alle Seiten laden ohne Fehler und ohne seitliches Überlaufen · desktop

Status: passed · Dauer 3.2 s

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

Status: passed · Dauer 59.7 s

**Bildschirm am Ende**

![Bildschirm am Ende](media/014-desktop-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/015-desktop-Tabellen-Sortieren-Filtern-Suchen-und-Zurücksetzen-a.webm)

### ✅ Dashboard: Kennzahlen, Links und Agent-Aktionen · desktop

Status: passed · Dauer 2.5 s

**Agent-Aktionen**

![Agent-Aktionen](media/016-desktop-Agent-Aktionen.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/017-desktop-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/018-desktop-Dashboard-Kennzahlen-Links-und-Agent-Aktionen.webm)

### ✅ Auftrag: anlegen, Status ändern, erneut versuchen, analysieren, löschen · desktop

Status: passed · Dauer 2.6 s

**Neuer Auftrag geklickt**

![Neuer Auftrag geklickt](media/019-desktop-Neuer-Auftrag-geklickt.png)

**Auftrag Details**

![Auftrag Details](media/020-desktop-Auftrag-Details.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/021-desktop-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/022-desktop-Auftrag-anlegen-Status-ändern-erneut-versuchen-analy.webm)

### ✅ Ideen: anlegen, öffnen, kommentieren, Auftrag erstellen lassen · desktop

Status: passed · Dauer 2.2 s

**Idee mit Kommentar**

![Idee mit Kommentar](media/023-desktop-Idee-mit-Kommentar.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/024-desktop-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/025-desktop-Ideen-anlegen-öffnen-kommentieren-Auftrag-erstellen-.webm)

### ✅ Bugs: anlegen, Status ändern, bearbeiten, löschen · desktop

Status: passed · Dauer 2.6 s

**Bug bearbeitet**

![Bug bearbeitet](media/026-desktop-Bug-bearbeitet.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/027-desktop-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/028-desktop-Bugs-anlegen-Status-ändern-bearbeiten-löschen.webm)

### ✅ Sprints: Datum prüfen, anlegen, Board öffnen, starten · desktop

Status: passed · Dauer 1.8 s

**Sprint-Board**

![Sprint-Board](media/029-desktop-Sprint-Board.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/030-desktop-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/031-desktop-Sprints-Datum-prüfen-anlegen-Board-öffnen-starten.webm)

### ✅ Dokumentation: Markdown, bearbeiten, einreichen, freigeben, neues Handbuch · desktop

Status: passed · Dauer 2.9 s

**Doku Architektur**

![Doku Architektur](media/032-desktop-Doku-Architektur.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/033-desktop-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/034-desktop-Dokumentation-Markdown-bearbeiten-einreichen-freigeb.webm)

### ✅ Agents: anlegen, Reihenfolge, aktivieren, Detailansicht · desktop

Status: passed · Dauer 2.2 s

**Agent-Detail**

![Agent-Detail](media/035-desktop-Agent-Detail.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/036-desktop-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/037-desktop-Agents-anlegen-Reihenfolge-aktivieren-Detailansicht.webm)

### ✅ Einstellungen: Validierungen, Benutzer anlegen, Projekt löschen gesperrt · desktop

Status: passed · Dauer 3.1 s

**Einstellungen**

![Einstellungen](media/038-desktop-Einstellungen.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/039-desktop-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/040-desktop-Einstellungen-Validierungen-Benutzer-anlegen-Projekt.webm)

### ✅ Projektwechsel trennt die Daten · desktop

Status: passed · Dauer 2.2 s

**Bildschirm am Ende**

![Bildschirm am Ende](media/041-desktop-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/042-desktop-Projektwechsel-trennt-die-Daten.webm)

### ✅ Rollen: Autorin sieht nur, was sie darf · desktop

Status: passed · Dauer 1.2 s

**Ansicht der Autorin**

![Ansicht der Autorin](media/043-desktop-Ansicht-der-Autorin.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/044-desktop-Bildschirm-am-Ende.png)

### ✅ Jeder Knopf und Link: anklicken, Dialoge bearbeiten und speichern, ohne Fehler · desktop

Status: passed · Dauer 225.2 s

**Klicktest dashboard**

![Klicktest dashboard](media/045-desktop-Klicktest-dashboard.png)

**Klicktest actions**

![Klicktest actions](media/046-desktop-Klicktest-actions.png)

**Klicktest docs**

![Klicktest docs](media/047-desktop-Klicktest-docs.png)

**Klicktest ideation**

![Klicktest ideation](media/048-desktop-Klicktest-ideation.png)

**Klicktest development**

![Klicktest development](media/049-desktop-Klicktest-development.png)

**Klicktest sprints**

![Klicktest sprints](media/050-desktop-Klicktest-sprints.png)

**Klicktest bugs**

![Klicktest bugs](media/051-desktop-Klicktest-bugs.png)

**Klicktest runs**

![Klicktest runs](media/052-desktop-Klicktest-runs.png)

**Klicktest agents**

![Klicktest agents](media/053-desktop-Klicktest-agents.png)

**Klicktest stats**

![Klicktest stats](media/054-desktop-Klicktest-stats.png)

**Klicktest settings**

![Klicktest settings](media/055-desktop-Klicktest-settings.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/056-desktop-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/057-desktop-Jeder-Knopf-und-Link-anklicken-Dialoge-bearbeiten-un.webm)

### ✅ Alle Seiten laden ohne Fehler und ohne seitliches Überlaufen · handy

Status: passed · Dauer 5.0 s

**dashboard (Handy)**

![dashboard (Handy)](media/058-handy-dashboard-Handy.png)

**actions (Handy)**

![actions (Handy)](media/059-handy-actions-Handy.png)

**docs (Handy)**

![docs (Handy)](media/060-handy-docs-Handy.png)

**ideation (Handy)**

![ideation (Handy)](media/061-handy-ideation-Handy.png)

**development (Handy)**

![development (Handy)](media/062-handy-development-Handy.png)

**sprints (Handy)**

![sprints (Handy)](media/063-handy-sprints-Handy.png)

**bugs (Handy)**

![bugs (Handy)](media/064-handy-bugs-Handy.png)

**runs (Handy)**

![runs (Handy)](media/065-handy-runs-Handy.png)

**agents (Handy)**

![agents (Handy)](media/066-handy-agents-Handy.png)

**stats (Handy)**

![stats (Handy)](media/067-handy-stats-Handy.png)

**settings (Handy)**

![settings (Handy)](media/068-handy-settings-Handy.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/069-handy-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/070-handy-Alle-Seiten-laden-ohne-Fehler-und-ohne-seitliches-Über.webm)

### ⏭️ Tabellen: Sortieren, Filtern, Suchen und Zurücksetzen auf allen Seiten · handy

Status: skipped · Dauer 0.2 s

**Bildschirm am Ende**

![Bildschirm am Ende](media/071-handy-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/072-handy-Tabellen-Sortieren-Filtern-Suchen-und-Zurücksetzen-auf.webm)

### ⏭️ Dashboard: Kennzahlen, Links und Agent-Aktionen · handy

Status: skipped · Dauer 0.2 s

**Bildschirm am Ende**

![Bildschirm am Ende](media/073-handy-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/074-handy-Dashboard-Kennzahlen-Links-und-Agent-Aktionen.webm)

### ⏭️ Auftrag: anlegen, Status ändern, erneut versuchen, analysieren, löschen · handy

Status: skipped · Dauer 0.1 s

**Bildschirm am Ende**

![Bildschirm am Ende](media/075-handy-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/076-handy-Auftrag-anlegen-Status-ändern-erneut-versuchen-analysi.webm)

### ⏭️ Ideen: anlegen, öffnen, kommentieren, Auftrag erstellen lassen · handy

Status: skipped · Dauer 0.2 s

**Bildschirm am Ende**

![Bildschirm am Ende](media/077-handy-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/078-handy-Ideen-anlegen-öffnen-kommentieren-Auftrag-erstellen-la.webm)

### ⏭️ Bugs: anlegen, Status ändern, bearbeiten, löschen · handy

Status: skipped · Dauer 0.2 s

**Bildschirm am Ende**

![Bildschirm am Ende](media/079-handy-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/080-handy-Bugs-anlegen-Status-ändern-bearbeiten-löschen.webm)

### ⏭️ Sprints: Datum prüfen, anlegen, Board öffnen, starten · handy

Status: skipped · Dauer 0.2 s

**Bildschirm am Ende**

![Bildschirm am Ende](media/081-handy-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/082-handy-Sprints-Datum-prüfen-anlegen-Board-öffnen-starten.webm)

### ⏭️ Dokumentation: Markdown, bearbeiten, einreichen, freigeben, neues Handbuch · handy

Status: skipped · Dauer 0.1 s

**Bildschirm am Ende**

![Bildschirm am Ende](media/083-handy-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/084-handy-Dokumentation-Markdown-bearbeiten-einreichen-freigeben.webm)

### ⏭️ Agents: anlegen, Reihenfolge, aktivieren, Detailansicht · handy

Status: skipped · Dauer 0.2 s

**Bildschirm am Ende**

![Bildschirm am Ende](media/085-handy-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/086-handy-Agents-anlegen-Reihenfolge-aktivieren-Detailansicht.webm)

### ✅ Einstellungen: Validierungen, Benutzer anlegen, Projekt löschen gesperrt · handy

Status: passed · Dauer 1.9 s

**Projekt löschen (Handy)**

![Projekt löschen (Handy)](media/087-handy-Projekt-löschen-Handy.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/088-handy-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/089-handy-Einstellungen-Validierungen-Benutzer-anlegen-Projekt-l.webm)

### ⏭️ Projektwechsel trennt die Daten · handy

Status: skipped · Dauer 0.2 s

**Bildschirm am Ende**

![Bildschirm am Ende](media/090-handy-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/091-handy-Projektwechsel-trennt-die-Daten.webm)

### ✅ Rollen: Autorin sieht nur, was sie darf · handy

Status: passed · Dauer 2.0 s

**Ansicht der Autorin**

![Ansicht der Autorin](media/092-handy-Ansicht-der-Autorin.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/093-handy-Bildschirm-am-Ende.png)

### ✅ Jeder Knopf und Link: anklicken, Dialoge bearbeiten und speichern, ohne Fehler · handy

Status: passed · Dauer 173.1 s

**Klicktest dashboard (Handy)**

![Klicktest dashboard (Handy)](media/094-handy-Klicktest-dashboard-Handy.png)

**Klicktest actions (Handy)**

![Klicktest actions (Handy)](media/095-handy-Klicktest-actions-Handy.png)

**Klicktest docs (Handy)**

![Klicktest docs (Handy)](media/096-handy-Klicktest-docs-Handy.png)

**Klicktest ideation (Handy)**

![Klicktest ideation (Handy)](media/097-handy-Klicktest-ideation-Handy.png)

**Klicktest development (Handy)**

![Klicktest development (Handy)](media/098-handy-Klicktest-development-Handy.png)

**Klicktest sprints (Handy)**

![Klicktest sprints (Handy)](media/099-handy-Klicktest-sprints-Handy.png)

**Klicktest bugs (Handy)**

![Klicktest bugs (Handy)](media/100-handy-Klicktest-bugs-Handy.png)

**Klicktest runs (Handy)**

![Klicktest runs (Handy)](media/101-handy-Klicktest-runs-Handy.png)

**Klicktest agents (Handy)**

![Klicktest agents (Handy)](media/102-handy-Klicktest-agents-Handy.png)

**Klicktest stats (Handy)**

![Klicktest stats (Handy)](media/103-handy-Klicktest-stats-Handy.png)

**Klicktest settings (Handy)**

![Klicktest settings (Handy)](media/104-handy-Klicktest-settings-Handy.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/105-handy-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/106-handy-Jeder-Knopf-und-Link-anklicken-Dialoge-bearbeiten-und-.webm)

## Ausgabe fehlgeschlagener Prüfungen

