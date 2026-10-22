# Testbericht 22.10.2026, 08:07:11

Erstellt mit `npm run test:full`. Gesamtergebnis: ❌ mit Befunden.
Der Oberflächentest läuft auf einer eigenen Testdatenbank (dev_log_full) ohne Worker: Agents, Chat-Antworten und der Projekt-Assistent starten dort nicht.
In AIdeation abgelegt: Projekt `dev-log`, Testlauf `eeced745-3d94-4583-9e63-3f6c1e6a8850`.

## Übersicht

| Prüfung | Ergebnis | Dauer | Zusammenfassung |
|---|---|---|---|
| Lint | ✅ | 6 s | 564 problems (0 errors, 564 warnings) |
| Formatierung | ❌ | 9 s | nicht formatiert: src/agent/tool-sql-guard.test.ts |
| Typprüfung | ✅ | 11 s | Backend und Oberfläche |
| Unit-Tests (inkl. UI-Build) | ✅ | 41 s | 976 bestanden, 0 fehlgeschlagen, 6 Build-Warnungen |
| E2E-Tests | ✅ | 167 s | 63 passed, 3 skipped |
| Oberflächentest | ✅ | 637 s | 19 passed, 9 skipped |

## Befunde des Oberflächentests

Keine Befunde.

## Oberflächentest im Detail

### ✅ Alle Seiten laden ohne Fehler und ohne seitliches Überlaufen · desktop

Status: passed · Dauer 5.1 s

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

Status: passed · Dauer 77.9 s

**Bildschirm am Ende**

![Bildschirm am Ende](media/013-desktop-Bildschirm-am-Ende.png)

### ✅ Dashboard: Kennzahlen, Links und Agent-Aktionen · desktop

Status: passed · Dauer 4.0 s

**Agent-Aktionen**

![Agent-Aktionen](media/014-desktop-Agent-Aktionen.png)

**Agent-Aktion Verlauf**

![Agent-Aktion Verlauf](media/015-desktop-Agent-Aktion-Verlauf.png)

**Agent-Aktion Zeitplan**

![Agent-Aktion Zeitplan](media/016-desktop-Agent-Aktion-Zeitplan.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/017-desktop-Bildschirm-am-Ende.png)

### ✅ Auftrag: anlegen, Status ändern, erneut versuchen, analysieren, löschen · desktop

Status: passed · Dauer 3.9 s

**Neuer Auftrag geklickt**

![Neuer Auftrag geklickt](media/018-desktop-Neuer-Auftrag-geklickt.png)

**Auftrag Details**

![Auftrag Details](media/019-desktop-Auftrag-Details.png)

**Erneut versuchen bestätigen**

![Erneut versuchen bestätigen](media/020-desktop-Erneut-versuchen-bestätigen.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/021-desktop-Bildschirm-am-Ende.png)

### ✅ Ideen: anlegen, öffnen, kommentieren, Auftrag erstellen lassen · desktop

Status: passed · Dauer 3.0 s

**Idee mit Kommentar**

![Idee mit Kommentar](media/022-desktop-Idee-mit-Kommentar.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/023-desktop-Bildschirm-am-Ende.png)

### ✅ Bugs: anlegen, Status ändern, bearbeiten, löschen · desktop

Status: passed · Dauer 3.0 s

**Bug bearbeitet**

![Bug bearbeitet](media/024-desktop-Bug-bearbeitet.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/025-desktop-Bildschirm-am-Ende.png)

### ✅ Sprints: Datum prüfen, anlegen, Aufträge zeigen, starten · desktop

Status: passed · Dauer 3.4 s

**Sprint-Aufträge**

![Sprint-Aufträge](media/026-desktop-Sprint-Aufträge.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/027-desktop-Bildschirm-am-Ende.png)

### ✅ Dokumentation: Markdown, bearbeiten, einreichen, freigeben, neues Handbuch · desktop

Status: passed · Dauer 3.2 s

**Doku Architektur**

![Doku Architektur](media/028-desktop-Doku-Architektur.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/029-desktop-Bildschirm-am-Ende.png)

### ✅ Agents: anlegen, Reihenfolge, aktivieren, Detailansicht · desktop

Status: passed · Dauer 2.6 s

**Agent-Detail**

![Agent-Detail](media/030-desktop-Agent-Detail.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/031-desktop-Bildschirm-am-Ende.png)

### ✅ Agents: „Was machen die Rollen?“ auf- und zuklappen · desktop

Status: passed · Dauer 2.2 s

**Was machen die Rollen**

![Was machen die Rollen](media/032-desktop-Was-machen-die-Rollen.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/033-desktop-Bildschirm-am-Ende.png)

### ✅ Einstellungen: Validierungen, Benutzer anlegen, Projekt löschen gesperrt · desktop

Status: passed · Dauer 3.6 s

**Einstellungen**

![Einstellungen](media/034-desktop-Einstellungen.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/035-desktop-Bildschirm-am-Ende.png)

### ✅ Projektwechsel trennt die Daten · desktop

Status: passed · Dauer 2.9 s

**Bildschirm am Ende**

![Bildschirm am Ende](media/036-desktop-Bildschirm-am-Ende.png)

### ✅ Rollen: Autorin sieht nur, was sie darf · desktop

Status: passed · Dauer 1.9 s

**Ansicht der Autorin**

![Ansicht der Autorin](media/037-desktop-Ansicht-der-Autorin.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/038-desktop-Bildschirm-am-Ende.png)

### ✅ Jeder Knopf und Link: anklicken, Dialoge bearbeiten und speichern, ohne Fehler · desktop

Status: passed · Dauer 267.2 s

**Klicktest dashboard**

![Klicktest dashboard](media/039-desktop-Klicktest-dashboard.png)

**Klicktest actions**

![Klicktest actions](media/040-desktop-Klicktest-actions.png)

**Klicktest docs**

![Klicktest docs](media/041-desktop-Klicktest-docs.png)

**Klicktest ideation**

![Klicktest ideation](media/042-desktop-Klicktest-ideation.png)

**Klicktest development**

![Klicktest development](media/043-desktop-Klicktest-development.png)

**Klicktest sprints**

![Klicktest sprints](media/044-desktop-Klicktest-sprints.png)

**Klicktest bugs**

![Klicktest bugs](media/045-desktop-Klicktest-bugs.png)

**Klicktest runs**

![Klicktest runs](media/046-desktop-Klicktest-runs.png)

**Klicktest agents**

![Klicktest agents](media/047-desktop-Klicktest-agents.png)

**Klicktest stats**

![Klicktest stats](media/048-desktop-Klicktest-stats.png)

**Klicktest settings**

![Klicktest settings](media/049-desktop-Klicktest-settings.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/050-desktop-Bildschirm-am-Ende.png)

### ✅ Alle Seiten laden ohne Fehler und ohne seitliches Überlaufen · handy

Status: passed · Dauer 6.9 s

**dashboard (Handy)**

![dashboard (Handy)](media/051-handy-dashboard-Handy.png)

**actions (Handy)**

![actions (Handy)](media/052-handy-actions-Handy.png)

**docs (Handy)**

![docs (Handy)](media/053-handy-docs-Handy.png)

**ideation (Handy)**

![ideation (Handy)](media/054-handy-ideation-Handy.png)

**development (Handy)**

![development (Handy)](media/055-handy-development-Handy.png)

**sprints (Handy)**

![sprints (Handy)](media/056-handy-sprints-Handy.png)

**bugs (Handy)**

![bugs (Handy)](media/057-handy-bugs-Handy.png)

**runs (Handy)**

![runs (Handy)](media/058-handy-runs-Handy.png)

**agents (Handy)**

![agents (Handy)](media/059-handy-agents-Handy.png)

**stats (Handy)**

![stats (Handy)](media/060-handy-stats-Handy.png)

**settings (Handy)**

![settings (Handy)](media/061-handy-settings-Handy.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/062-handy-Bildschirm-am-Ende.png)

### ⏭️ Tabellen: Sortieren, Filtern, Suchen und Zurücksetzen auf allen Seiten · handy

Status: skipped · Dauer 0.4 s

**Bildschirm am Ende**

![Bildschirm am Ende](media/063-handy-Bildschirm-am-Ende.png)

### ⏭️ Dashboard: Kennzahlen, Links und Agent-Aktionen · handy

Status: skipped · Dauer 0.4 s

**Bildschirm am Ende**

![Bildschirm am Ende](media/064-handy-Bildschirm-am-Ende.png)

### ⏭️ Auftrag: anlegen, Status ändern, erneut versuchen, analysieren, löschen · handy

Status: skipped · Dauer 0.4 s

**Bildschirm am Ende**

![Bildschirm am Ende](media/065-handy-Bildschirm-am-Ende.png)

### ⏭️ Ideen: anlegen, öffnen, kommentieren, Auftrag erstellen lassen · handy

Status: skipped · Dauer 0.3 s

**Bildschirm am Ende**

![Bildschirm am Ende](media/066-handy-Bildschirm-am-Ende.png)

### ⏭️ Bugs: anlegen, Status ändern, bearbeiten, löschen · handy

Status: skipped · Dauer 0.4 s

**Bildschirm am Ende**

![Bildschirm am Ende](media/067-handy-Bildschirm-am-Ende.png)

### ⏭️ Sprints: Datum prüfen, anlegen, Aufträge zeigen, starten · handy

Status: skipped · Dauer 0.4 s

**Bildschirm am Ende**

![Bildschirm am Ende](media/068-handy-Bildschirm-am-Ende.png)

### ⏭️ Dokumentation: Markdown, bearbeiten, einreichen, freigeben, neues Handbuch · handy

Status: skipped · Dauer 0.3 s

**Bildschirm am Ende**

![Bildschirm am Ende](media/069-handy-Bildschirm-am-Ende.png)

### ⏭️ Agents: anlegen, Reihenfolge, aktivieren, Detailansicht · handy

Status: skipped · Dauer 0.3 s

**Bildschirm am Ende**

![Bildschirm am Ende](media/070-handy-Bildschirm-am-Ende.png)

### ✅ Agents: „Was machen die Rollen?“ auf- und zuklappen · handy

Status: passed · Dauer 2.1 s

**Was machen die Rollen**

![Was machen die Rollen](media/071-handy-Was-machen-die-Rollen.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/072-handy-Bildschirm-am-Ende.png)

### ✅ Einstellungen: Validierungen, Benutzer anlegen, Projekt löschen gesperrt · handy

Status: passed · Dauer 2.1 s

**Projekt löschen (Handy)**

![Projekt löschen (Handy)](media/073-handy-Projekt-löschen-Handy.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/074-handy-Bildschirm-am-Ende.png)

### ⏭️ Projektwechsel trennt die Daten · handy

Status: skipped · Dauer 0.3 s

**Bildschirm am Ende**

![Bildschirm am Ende](media/075-handy-Bildschirm-am-Ende.png)

### ✅ Rollen: Autorin sieht nur, was sie darf · handy

Status: passed · Dauer 2.2 s

**Ansicht der Autorin**

![Ansicht der Autorin](media/076-handy-Ansicht-der-Autorin.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/077-handy-Bildschirm-am-Ende.png)

### ✅ Jeder Knopf und Link: anklicken, Dialoge bearbeiten und speichern, ohne Fehler · handy

Status: passed · Dauer 228.4 s

**Klicktest dashboard (Handy)**

![Klicktest dashboard (Handy)](media/078-handy-Klicktest-dashboard-Handy.png)

**Klicktest actions (Handy)**

![Klicktest actions (Handy)](media/079-handy-Klicktest-actions-Handy.png)

**Klicktest docs (Handy)**

![Klicktest docs (Handy)](media/080-handy-Klicktest-docs-Handy.png)

**Klicktest ideation (Handy)**

![Klicktest ideation (Handy)](media/081-handy-Klicktest-ideation-Handy.png)

**Klicktest development (Handy)**

![Klicktest development (Handy)](media/082-handy-Klicktest-development-Handy.png)

**Klicktest sprints (Handy)**

![Klicktest sprints (Handy)](media/083-handy-Klicktest-sprints-Handy.png)

**Klicktest bugs (Handy)**

![Klicktest bugs (Handy)](media/084-handy-Klicktest-bugs-Handy.png)

**Klicktest runs (Handy)**

![Klicktest runs (Handy)](media/085-handy-Klicktest-runs-Handy.png)

**Klicktest agents (Handy)**

![Klicktest agents (Handy)](media/086-handy-Klicktest-agents-Handy.png)

**Klicktest stats (Handy)**

![Klicktest stats (Handy)](media/087-handy-Klicktest-stats-Handy.png)

**Klicktest settings (Handy)**

![Klicktest settings (Handy)](media/088-handy-Klicktest-settings-Handy.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/089-handy-Bildschirm-am-Ende.png)

## Ausgabe fehlgeschlagener Prüfungen

<details><summary>Formatierung</summary>

```text
> dev-log@1.0.0 format:check
> prettier --check src frontend/src

Checking formatting...
[warn] src/agent/tool-sql-guard.test.ts
[warn] Code style issues found in the above file. Run Prettier with --write to fix.
```

</details>

