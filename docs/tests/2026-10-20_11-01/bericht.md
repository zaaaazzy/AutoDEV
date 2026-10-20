# Testbericht 20.10.2026, 11:01:23

Erstellt mit `npm run test:full`. Gesamtergebnis: ✅ alles grün.
Der Oberflächentest läuft auf einer eigenen Testdatenbank (dev_log_full) ohne Worker: Agents, Chat-Antworten und der Projekt-Assistent starten dort nicht.
In AIdeation abgelegt: Projekt `dev-log`, Testlauf `2e705943-d8fa-4efd-b4bf-14b7075949a4`.

## Übersicht

| Prüfung | Ergebnis | Dauer | Zusammenfassung |
|---|---|---|---|
| Lint | ✅ | 3 s | 328 problems (0 errors, 328 warnings) |
| Formatierung | ✅ | 4 s | alles formatiert |
| Typprüfung | ✅ | 3 s | Backend und Oberfläche |
| Unit-Tests (inkl. UI-Build) | ✅ | 21 s | 353 bestanden, 0 fehlgeschlagen, 4 Build-Warnungen |
| E2E-Tests | ✅ | 51 s | 41 passed, 1 skipped |
| Oberflächentest | ✅ | 530 s | 17 passed, 9 skipped |

## Befunde des Oberflächentests

Keine Befunde.

## Oberflächentest im Detail

### ✅ Alle Seiten laden ohne Fehler und ohne seitliches Überlaufen · desktop

Status: passed · Dauer 3.1 s

**dashboard**

![dashboard](media/001-desktop-dashboard.png)

**docs**

![docs](media/002-desktop-docs.png)

**ideation**

![ideation](media/003-desktop-ideation.png)

**development**

![development](media/004-desktop-development.png)

**sprints**

![sprints](media/005-desktop-sprints.png)

**bugs**

![bugs](media/006-desktop-bugs.png)

**runs**

![runs](media/007-desktop-runs.png)

**agents**

![agents](media/008-desktop-agents.png)

**stats**

![stats](media/009-desktop-stats.png)

**settings**

![settings](media/010-desktop-settings.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/011-desktop-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/012-desktop-Alle-Seiten-laden-ohne-Fehler-und-ohne-seitliches-Üb.webm)

### ✅ Tabellen: Sortieren, Filtern, Suchen und Zurücksetzen auf allen Seiten · desktop

Status: passed · Dauer 87.1 s

**Bildschirm am Ende**

![Bildschirm am Ende](media/013-desktop-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/014-desktop-Tabellen-Sortieren-Filtern-Suchen-und-Zurücksetzen-a.webm)

### ✅ Dashboard: Kennzahlen, Links und Agent-Aktionen · desktop

Status: passed · Dauer 2.3 s

**Agent-Aktionen**

![Agent-Aktionen](media/015-desktop-Agent-Aktionen.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/016-desktop-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/017-desktop-Dashboard-Kennzahlen-Links-und-Agent-Aktionen.webm)

### ✅ Auftrag: anlegen, Status ändern, erneut versuchen, analysieren, löschen · desktop

Status: passed · Dauer 3.4 s

**Neuer Auftrag geklickt**

![Neuer Auftrag geklickt](media/018-desktop-Neuer-Auftrag-geklickt.png)

**Auftrag Details**

![Auftrag Details](media/019-desktop-Auftrag-Details.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/020-desktop-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/021-desktop-Auftrag-anlegen-Status-ändern-erneut-versuchen-analy.webm)

### ✅ Ideen: anlegen, öffnen, kommentieren, Auftrag erstellen lassen · desktop

Status: passed · Dauer 3.0 s

**Idee mit Kommentar**

![Idee mit Kommentar](media/022-desktop-Idee-mit-Kommentar.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/023-desktop-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/024-desktop-Ideen-anlegen-öffnen-kommentieren-Auftrag-erstellen-.webm)

### ✅ Bugs: anlegen, Status ändern, bearbeiten, löschen · desktop

Status: passed · Dauer 2.7 s

**Bug bearbeitet**

![Bug bearbeitet](media/025-desktop-Bug-bearbeitet.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/026-desktop-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/027-desktop-Bugs-anlegen-Status-ändern-bearbeiten-löschen.webm)

### ✅ Sprints: Datum prüfen, anlegen, Board öffnen, starten · desktop

Status: passed · Dauer 1.9 s

**Sprint-Board**

![Sprint-Board](media/028-desktop-Sprint-Board.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/029-desktop-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/030-desktop-Sprints-Datum-prüfen-anlegen-Board-öffnen-starten.webm)

### ✅ Dokumentation: Markdown, bearbeiten, einreichen, freigeben, neues Handbuch · desktop

Status: passed · Dauer 3.4 s

**Doku Architektur**

![Doku Architektur](media/031-desktop-Doku-Architektur.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/032-desktop-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/033-desktop-Dokumentation-Markdown-bearbeiten-einreichen-freigeb.webm)

### ✅ Agents: anlegen, Reihenfolge, aktivieren, Detailansicht · desktop

Status: passed · Dauer 1.8 s

**Agent-Detail**

![Agent-Detail](media/034-desktop-Agent-Detail.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/035-desktop-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/036-desktop-Agents-anlegen-Reihenfolge-aktivieren-Detailansicht.webm)

### ✅ Einstellungen: Validierungen, Benutzer anlegen, Projekt löschen gesperrt · desktop

Status: passed · Dauer 2.7 s

**Einstellungen**

![Einstellungen](media/037-desktop-Einstellungen.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/038-desktop-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/039-desktop-Einstellungen-Validierungen-Benutzer-anlegen-Projekt.webm)

### ✅ Projektwechsel trennt die Daten · desktop

Status: passed · Dauer 2.5 s

**Bildschirm am Ende**

![Bildschirm am Ende](media/040-desktop-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/041-desktop-Projektwechsel-trennt-die-Daten.webm)

### ✅ Rollen: Autorin sieht nur, was sie darf · desktop

Status: passed · Dauer 1.3 s

**Ansicht der Autorin**

![Ansicht der Autorin](media/042-desktop-Ansicht-der-Autorin.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/043-desktop-Bildschirm-am-Ende.png)

### ✅ Jeder Knopf und Link: anklicken, Dialoge bearbeiten und speichern, ohne Fehler · desktop

Status: passed · Dauer 221.0 s

**Klicktest dashboard**

![Klicktest dashboard](media/044-desktop-Klicktest-dashboard.png)

**Klicktest docs**

![Klicktest docs](media/045-desktop-Klicktest-docs.png)

**Klicktest ideation**

![Klicktest ideation](media/046-desktop-Klicktest-ideation.png)

**Klicktest development**

![Klicktest development](media/047-desktop-Klicktest-development.png)

**Klicktest sprints**

![Klicktest sprints](media/048-desktop-Klicktest-sprints.png)

**Klicktest bugs**

![Klicktest bugs](media/049-desktop-Klicktest-bugs.png)

**Klicktest runs**

![Klicktest runs](media/050-desktop-Klicktest-runs.png)

**Klicktest agents**

![Klicktest agents](media/051-desktop-Klicktest-agents.png)

**Klicktest stats**

![Klicktest stats](media/052-desktop-Klicktest-stats.png)

**Klicktest settings**

![Klicktest settings](media/053-desktop-Klicktest-settings.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/054-desktop-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/055-desktop-Jeder-Knopf-und-Link-anklicken-Dialoge-bearbeiten-un.webm)

### ✅ Alle Seiten laden ohne Fehler und ohne seitliches Überlaufen · handy

Status: passed · Dauer 5.0 s

**dashboard (Handy)**

![dashboard (Handy)](media/056-handy-dashboard-Handy.png)

**docs (Handy)**

![docs (Handy)](media/057-handy-docs-Handy.png)

**ideation (Handy)**

![ideation (Handy)](media/058-handy-ideation-Handy.png)

**development (Handy)**

![development (Handy)](media/059-handy-development-Handy.png)

**sprints (Handy)**

![sprints (Handy)](media/060-handy-sprints-Handy.png)

**bugs (Handy)**

![bugs (Handy)](media/061-handy-bugs-Handy.png)

**runs (Handy)**

![runs (Handy)](media/062-handy-runs-Handy.png)

**agents (Handy)**

![agents (Handy)](media/063-handy-agents-Handy.png)

**stats (Handy)**

![stats (Handy)](media/064-handy-stats-Handy.png)

**settings (Handy)**

![settings (Handy)](media/065-handy-settings-Handy.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/066-handy-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/067-handy-Alle-Seiten-laden-ohne-Fehler-und-ohne-seitliches-Über.webm)

### ⏭️ Tabellen: Sortieren, Filtern, Suchen und Zurücksetzen auf allen Seiten · handy

Status: skipped · Dauer 0.2 s

**Bildschirm am Ende**

![Bildschirm am Ende](media/068-handy-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/069-handy-Tabellen-Sortieren-Filtern-Suchen-und-Zurücksetzen-auf.webm)

### ⏭️ Dashboard: Kennzahlen, Links und Agent-Aktionen · handy

Status: skipped · Dauer 0.1 s

**Bildschirm am Ende**

![Bildschirm am Ende](media/070-handy-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/071-handy-Dashboard-Kennzahlen-Links-und-Agent-Aktionen.webm)

### ⏭️ Auftrag: anlegen, Status ändern, erneut versuchen, analysieren, löschen · handy

Status: skipped · Dauer 0.2 s

**Bildschirm am Ende**

![Bildschirm am Ende](media/072-handy-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/073-handy-Auftrag-anlegen-Status-ändern-erneut-versuchen-analysi.webm)

### ⏭️ Ideen: anlegen, öffnen, kommentieren, Auftrag erstellen lassen · handy

Status: skipped · Dauer 0.2 s

**Bildschirm am Ende**

![Bildschirm am Ende](media/074-handy-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/075-handy-Ideen-anlegen-öffnen-kommentieren-Auftrag-erstellen-la.webm)

### ⏭️ Bugs: anlegen, Status ändern, bearbeiten, löschen · handy

Status: skipped · Dauer 0.2 s

**Bildschirm am Ende**

![Bildschirm am Ende](media/076-handy-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/077-handy-Bugs-anlegen-Status-ändern-bearbeiten-löschen.webm)

### ⏭️ Sprints: Datum prüfen, anlegen, Board öffnen, starten · handy

Status: skipped · Dauer 0.1 s

**Bildschirm am Ende**

![Bildschirm am Ende](media/078-handy-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/079-handy-Sprints-Datum-prüfen-anlegen-Board-öffnen-starten.webm)

### ⏭️ Dokumentation: Markdown, bearbeiten, einreichen, freigeben, neues Handbuch · handy

Status: skipped · Dauer 0.2 s

**Bildschirm am Ende**

![Bildschirm am Ende](media/080-handy-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/081-handy-Dokumentation-Markdown-bearbeiten-einreichen-freigeben.webm)

### ⏭️ Agents: anlegen, Reihenfolge, aktivieren, Detailansicht · handy

Status: skipped · Dauer 0.2 s

**Bildschirm am Ende**

![Bildschirm am Ende](media/082-handy-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/083-handy-Agents-anlegen-Reihenfolge-aktivieren-Detailansicht.webm)

### ✅ Einstellungen: Validierungen, Benutzer anlegen, Projekt löschen gesperrt · handy

Status: passed · Dauer 1.9 s

**Projekt löschen (Handy)**

![Projekt löschen (Handy)](media/084-handy-Projekt-löschen-Handy.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/085-handy-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/086-handy-Einstellungen-Validierungen-Benutzer-anlegen-Projekt-l.webm)

### ⏭️ Projektwechsel trennt die Daten · handy

Status: skipped · Dauer 0.2 s

**Bildschirm am Ende**

![Bildschirm am Ende](media/087-handy-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/088-handy-Projektwechsel-trennt-die-Daten.webm)

### ✅ Rollen: Autorin sieht nur, was sie darf · handy

Status: passed · Dauer 2.3 s

**Ansicht der Autorin**

![Ansicht der Autorin](media/089-handy-Ansicht-der-Autorin.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/090-handy-Bildschirm-am-Ende.png)

### ✅ Jeder Knopf und Link: anklicken, Dialoge bearbeiten und speichern, ohne Fehler · handy

Status: passed · Dauer 179.2 s

**Klicktest dashboard (Handy)**

![Klicktest dashboard (Handy)](media/091-handy-Klicktest-dashboard-Handy.png)

**Klicktest docs (Handy)**

![Klicktest docs (Handy)](media/092-handy-Klicktest-docs-Handy.png)

**Klicktest ideation (Handy)**

![Klicktest ideation (Handy)](media/093-handy-Klicktest-ideation-Handy.png)

**Klicktest development (Handy)**

![Klicktest development (Handy)](media/094-handy-Klicktest-development-Handy.png)

**Klicktest sprints (Handy)**

![Klicktest sprints (Handy)](media/095-handy-Klicktest-sprints-Handy.png)

**Klicktest bugs (Handy)**

![Klicktest bugs (Handy)](media/096-handy-Klicktest-bugs-Handy.png)

**Klicktest runs (Handy)**

![Klicktest runs (Handy)](media/097-handy-Klicktest-runs-Handy.png)

**Klicktest agents (Handy)**

![Klicktest agents (Handy)](media/098-handy-Klicktest-agents-Handy.png)

**Klicktest stats (Handy)**

![Klicktest stats (Handy)](media/099-handy-Klicktest-stats-Handy.png)

**Klicktest settings (Handy)**

![Klicktest settings (Handy)](media/100-handy-Klicktest-settings-Handy.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/101-handy-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/102-handy-Jeder-Knopf-und-Link-anklicken-Dialoge-bearbeiten-und-.webm)

## Ausgabe fehlgeschlagener Prüfungen

