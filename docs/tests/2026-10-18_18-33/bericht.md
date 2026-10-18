# Testbericht 18.10.2026, 18:33:41

Erstellt mit `npm run test:full`. Gesamtergebnis: ❌ mit Befunden.
Der Oberflächentest läuft auf einer eigenen Testdatenbank (dev_log_full) ohne Worker: Agents, Chat-Antworten und der Projekt-Assistent starten dort nicht.

## Übersicht

| Prüfung | Ergebnis | Dauer | Zusammenfassung |
|---|---|---|---|
| Lint | ✅ | 2 s | 118 problems (0 errors, 118 warnings) |
| Formatierung | ✅ | 2 s | alles formatiert |
| Typprüfung | ✅ | 2 s | Backend und Oberfläche |
| Unit-Tests (inkl. UI-Build) | ✅ | 12 s | 142 bestanden, 0 fehlgeschlagen, 2 Build-Warnungen |
| E2E-Tests | ✅ | 37 s | 35 passed, 1 skipped |
| Oberflächentest | ❌ | 165 s | 6 passed, 9 failed, 9 skipped |

## Befunde des Oberflächentests

| Gerät | Test | Befund |
|---|---|---|
| desktop | Tabellen: Sortieren, Filtern, Suchen und Zurücksetzen auf allen Seiten | ideation · Tabelle „Alle Ideen“: Textfilter „Titel“ hat Fokus – |
| desktop | Tabellen: Sortieren, Filtern, Suchen und Zurücksetzen auf allen Seiten | development · Tabelle „Aufträge“: Textfilter „Titel“ hat Fokus – |
| desktop | Tabellen: Sortieren, Filtern, Suchen und Zurücksetzen auf allen Seiten | sprints · Tabelle „Sprints“: Textfilter „Sprint“ hat Fokus – |
| desktop | Tabellen: Sortieren, Filtern, Suchen und Zurücksetzen auf allen Seiten | bugs · Tabelle „Bugs“: Textfilter „Titel“ hat Fokus – |
| desktop | Tabellen: Sortieren, Filtern, Suchen und Zurücksetzen auf allen Seiten | runs · Tabelle „Testläufe“: Erster Klick auf „Gestartet“ sortiert (einheitlich) – Klickfolge →ascending→descending |
| desktop | Tabellen: Sortieren, Filtern, Suchen und Zurücksetzen auf allen Seiten | agents · Tabelle „Agents & Workflow“: Textfilter „Agent“ hat Fokus – |
| desktop | Tabellen: Sortieren, Filtern, Suchen und Zurücksetzen auf allen Seiten | stats · Tabelle „Schätzung gegen tatsächlich“: Textfilter „Auftrag“ hat Fokus – |
| desktop | Auftrag: anlegen, Status ändern, erneut versuchen, analysieren, löschen | Formular „Neuer Auftrag“ erscheint im sichtbaren Bereich |
| desktop | Ideen: anlegen, öffnen, kommentieren, Auftrag erstellen lassen | Beschreibung zeigt Markdown gerendert |
| desktop | Ideen: anlegen, öffnen, kommentieren, Auftrag erstellen lassen | Kommentar nennt den angemeldeten Benutzer |
| desktop | Ideen: anlegen, öffnen, kommentieren, Auftrag erstellen lassen | Escape schließt den Ideen-Dialog |
| desktop | Sprints: Datum prüfen, anlegen, Board öffnen, starten | „Sprint starten“ setzt das Startdatum |
| desktop | Dokumentation: Markdown, bearbeiten, einreichen, freigeben, neues Handbuch | Markdown-Tabelle wird als Tabelle gezeigt |
| desktop | Agents: anlegen, Reihenfolge, aktivieren, Detailansicht | Detail bleibt nach ↑ offen |
| desktop | Agents: anlegen, Reihenfolge, aktivieren, Detailansicht | Kein doppeltes „Sprint Sprint“ |
| desktop | Agents: anlegen, Reihenfolge, aktivieren, Detailansicht | Zurück-Button führt zur Agent-Liste |
| desktop | Projektwechsel trennt die Daten | Leertext ohne Filter spricht nicht von Filtern |
| desktop | Rollen: Autorin sieht nur, was sie darf | Ohne Chat-Rolle kein „Verlauf leeren“ |
| desktop | Rollen: Autorin sieht nur, was sie darf | Ohne Agent-Rolle kein „Erneut versuchen“ |
| desktop | Rollen: Autorin sieht nur, was sie darf | Ohne Agent-Verwaltung kein „Standard-Workflow anlegen“ |
| handy | Rollen: Autorin sieht nur, was sie darf | Ohne Chat-Rolle kein „Verlauf leeren“ |
| handy | Rollen: Autorin sieht nur, was sie darf | Ohne Agent-Rolle kein „Erneut versuchen“ |
| handy | Rollen: Autorin sieht nur, was sie darf | Ohne Agent-Verwaltung kein „Standard-Workflow anlegen“ |

## Oberflächentest im Detail

### ✅ Alle Seiten laden ohne Fehler und ohne seitliches Überlaufen · desktop

Status: passed · Dauer 2.1 s

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

**Alle Seiten laden ohne Fehler und ohne seitliches Überlaufen · desktop (Ende)**

![Alle Seiten laden ohne Fehler und ohne seitliches Überlaufen · desktop (Ende)](media/011-desktop-Alle-Seiten-laden-ohne-Fehler-und-ohne-seitliches-Üb.png)

🎬 [Video ansehen](media/012-desktop-Alle-Seiten-laden-ohne-Fehler-und-ohne-seitliches-Üb.webm)

### ❌ Tabellen: Sortieren, Filtern, Suchen und Zurücksetzen auf allen Seiten · desktop

Status: failed · Dauer 52.3 s

**Befunde:**

- ideation · Tabelle „Alle Ideen“: Textfilter „Titel“ hat Fokus –
- development · Tabelle „Aufträge“: Textfilter „Titel“ hat Fokus –
- sprints · Tabelle „Sprints“: Textfilter „Sprint“ hat Fokus –
- bugs · Tabelle „Bugs“: Textfilter „Titel“ hat Fokus –
- runs · Tabelle „Testläufe“: Erster Klick auf „Gestartet“ sortiert (einheitlich) – Klickfolge →ascending→descending
- agents · Tabelle „Agents & Workflow“: Textfilter „Agent“ hat Fokus –
- stats · Tabelle „Schätzung gegen tatsächlich“: Textfilter „Auftrag“ hat Fokus –

**Tabellen: Sortieren, Filtern, Suchen und Zurücksetzen auf allen Seiten · desktop (Ende)**

![Tabellen: Sortieren, Filtern, Suchen und Zurücksetzen auf allen Seiten · desktop (Ende)](media/013-desktop-Tabellen-Sortieren-Filtern-Suchen-und-Zurücksetzen-a.png)

🎬 [Video ansehen](media/014-desktop-Tabellen-Sortieren-Filtern-Suchen-und-Zurücksetzen-a.webm)

### ✅ Dashboard: Kennzahlen, Links und Agent-Aufgaben · desktop

Status: passed · Dauer 1.6 s

**Agent-Aufgaben**

![Agent-Aufgaben](media/015-desktop-Agent-Aufgaben.png)

**Dashboard: Kennzahlen, Links und Agent-Aufgaben · desktop (Ende)**

![Dashboard: Kennzahlen, Links und Agent-Aufgaben · desktop (Ende)](media/016-desktop-Dashboard-Kennzahlen-Links-und-Agent-Aufgaben-deskto.png)

🎬 [Video ansehen](media/017-desktop-Dashboard-Kennzahlen-Links-und-Agent-Aufgaben.webm)

### ❌ Auftrag: anlegen, Status ändern, erneut versuchen, analysieren, löschen · desktop

Status: failed · Dauer 6.7 s

**Befunde:**

- Formular „Neuer Auftrag“ erscheint im sichtbaren Bereich

**Neuer Auftrag geklickt**

![Neuer Auftrag geklickt](media/018-desktop-Neuer-Auftrag-geklickt.png)

**Auftrag Details**

![Auftrag Details](media/019-desktop-Auftrag-Details.png)

**Auftrag: anlegen, Status ändern, erneut versuchen, analysieren, löschen · desktop (Ende)**

![Auftrag: anlegen, Status ändern, erneut versuchen, analysieren, löschen · desktop (Ende)](media/020-desktop-Auftrag-anlegen-Status-ändern-erneut-versuchen-analy.png)

🎬 [Video ansehen](media/021-desktop-Auftrag-anlegen-Status-ändern-erneut-versuchen-analy.webm)

### ❌ Ideen: anlegen, öffnen, kommentieren, Auftrag erstellen lassen · desktop

Status: failed · Dauer 16.6 s

**Befunde:**

- Beschreibung zeigt Markdown gerendert
- Kommentar nennt den angemeldeten Benutzer
- Escape schließt den Ideen-Dialog

**Idee mit Kommentar**

![Idee mit Kommentar](media/022-desktop-Idee-mit-Kommentar.png)

**Ideen: anlegen, öffnen, kommentieren, Auftrag erstellen lassen · desktop (Ende)**

![Ideen: anlegen, öffnen, kommentieren, Auftrag erstellen lassen · desktop (Ende)](media/023-desktop-Ideen-anlegen-öffnen-kommentieren-Auftrag-erstellen-.png)

🎬 [Video ansehen](media/024-desktop-Ideen-anlegen-öffnen-kommentieren-Auftrag-erstellen-.webm)

### ✅ Bugs: anlegen, Status ändern, bearbeiten, löschen · desktop

Status: passed · Dauer 1.6 s

**Bug bearbeitet**

![Bug bearbeitet](media/025-desktop-Bug-bearbeitet.png)

**Bugs: anlegen, Status ändern, bearbeiten, löschen · desktop (Ende)**

![Bugs: anlegen, Status ändern, bearbeiten, löschen · desktop (Ende)](media/026-desktop-Bugs-anlegen-Status-ändern-bearbeiten-löschen-deskto.png)

🎬 [Video ansehen](media/027-desktop-Bugs-anlegen-Status-ändern-bearbeiten-löschen.webm)

### ❌ Sprints: Datum prüfen, anlegen, Board öffnen, starten · desktop

Status: failed · Dauer 6.8 s

**Befunde:**

- „Sprint starten“ setzt das Startdatum

**Sprint-Board**

![Sprint-Board](media/028-desktop-Sprint-Board.png)

**Sprints: Datum prüfen, anlegen, Board öffnen, starten · desktop (Ende)**

![Sprints: Datum prüfen, anlegen, Board öffnen, starten · desktop (Ende)](media/029-desktop-Sprints-Datum-prüfen-anlegen-Board-öffnen-starten-de.png)

🎬 [Video ansehen](media/030-desktop-Sprints-Datum-prüfen-anlegen-Board-öffnen-starten.webm)

### ❌ Dokumentation: Markdown, bearbeiten, einreichen, freigeben, neues Handbuch · desktop

Status: failed · Dauer 6.7 s

**Befunde:**

- Markdown-Tabelle wird als Tabelle gezeigt

**Doku Architektur**

![Doku Architektur](media/031-desktop-Doku-Architektur.png)

**Dokumentation: Markdown, bearbeiten, einreichen, freigeben, neues Handbuch · desktop (Ende)**

![Dokumentation: Markdown, bearbeiten, einreichen, freigeben, neues Handbuch · desktop (Ende)](media/032-desktop-Dokumentation-Markdown-bearbeiten-einreichen-freigeb.png)

🎬 [Video ansehen](media/033-desktop-Dokumentation-Markdown-bearbeiten-einreichen-freigeb.webm)

### ❌ Agents: anlegen, Reihenfolge, aktivieren, Detailansicht · desktop

Status: failed · Dauer 17.1 s

**Befunde:**

- Detail bleibt nach ↑ offen
- Kein doppeltes „Sprint Sprint“
- Zurück-Button führt zur Agent-Liste

**Agent-Detail**

![Agent-Detail](media/034-desktop-Agent-Detail.png)

**Agents: anlegen, Reihenfolge, aktivieren, Detailansicht · desktop (Ende)**

![Agents: anlegen, Reihenfolge, aktivieren, Detailansicht · desktop (Ende)](media/035-desktop-Agents-anlegen-Reihenfolge-aktivieren-Detailansicht-.png)

🎬 [Video ansehen](media/036-desktop-Agents-anlegen-Reihenfolge-aktivieren-Detailansicht.webm)

### ✅ Einstellungen: Validierungen, Benutzer anlegen, Projekt löschen gesperrt · desktop

Status: passed · Dauer 1.9 s

**Einstellungen**

![Einstellungen](media/037-desktop-Einstellungen.png)

**Einstellungen: Validierungen, Benutzer anlegen, Projekt löschen gesperrt · desktop (Ende)**

![Einstellungen: Validierungen, Benutzer anlegen, Projekt löschen gesperrt · desktop (Ende)](media/038-desktop-Einstellungen-Validierungen-Benutzer-anlegen-Projekt.png)

🎬 [Video ansehen](media/039-desktop-Einstellungen-Validierungen-Benutzer-anlegen-Projekt.webm)

### ❌ Projektwechsel trennt die Daten · desktop

Status: failed · Dauer 6.9 s

**Befunde:**

- Leertext ohne Filter spricht nicht von Filtern

**Projektwechsel trennt die Daten · desktop (Ende)**

![Projektwechsel trennt die Daten · desktop (Ende)](media/040-desktop-Projektwechsel-trennt-die-Daten-desktop-Ende.png)

🎬 [Video ansehen](media/041-desktop-Projektwechsel-trennt-die-Daten.webm)

### ❌ Rollen: Autorin sieht nur, was sie darf · desktop

Status: failed · Dauer 16.4 s

**Befunde:**

- Ohne Chat-Rolle kein „Verlauf leeren“
- Ohne Agent-Rolle kein „Erneut versuchen“
- Ohne Agent-Verwaltung kein „Standard-Workflow anlegen“

**Ansicht der Autorin**

![Ansicht der Autorin](media/042-desktop-Ansicht-der-Autorin.png)

**Rollen: Autorin sieht nur, was sie darf · desktop (Ende)**

![Rollen: Autorin sieht nur, was sie darf · desktop (Ende)](media/043-desktop-Rollen-Autorin-sieht-nur-was-sie-darf-desktop-Ende.png)

### ✅ Alle Seiten laden ohne Fehler und ohne seitliches Überlaufen · handy

Status: passed · Dauer 3.6 s

**dashboard (Handy)**

![dashboard (Handy)](media/044-handy-dashboard-Handy.png)

**docs (Handy)**

![docs (Handy)](media/045-handy-docs-Handy.png)

**ideation (Handy)**

![ideation (Handy)](media/046-handy-ideation-Handy.png)

**development (Handy)**

![development (Handy)](media/047-handy-development-Handy.png)

**sprints (Handy)**

![sprints (Handy)](media/048-handy-sprints-Handy.png)

**bugs (Handy)**

![bugs (Handy)](media/049-handy-bugs-Handy.png)

**runs (Handy)**

![runs (Handy)](media/050-handy-runs-Handy.png)

**agents (Handy)**

![agents (Handy)](media/051-handy-agents-Handy.png)

**stats (Handy)**

![stats (Handy)](media/052-handy-stats-Handy.png)

**settings (Handy)**

![settings (Handy)](media/053-handy-settings-Handy.png)

**Alle Seiten laden ohne Fehler und ohne seitliches Überlaufen · handy (Ende)**

![Alle Seiten laden ohne Fehler und ohne seitliches Überlaufen · handy (Ende)](media/054-handy-Alle-Seiten-laden-ohne-Fehler-und-ohne-seitliches-Über.png)

🎬 [Video ansehen](media/055-handy-Alle-Seiten-laden-ohne-Fehler-und-ohne-seitliches-Über.webm)

### ⏭️ Tabellen: Sortieren, Filtern, Suchen und Zurücksetzen auf allen Seiten · handy

Status: skipped · Dauer 0.2 s

**Tabellen: Sortieren, Filtern, Suchen und Zurücksetzen auf allen Seiten · handy (Ende)**

![Tabellen: Sortieren, Filtern, Suchen und Zurücksetzen auf allen Seiten · handy (Ende)](media/056-handy-Tabellen-Sortieren-Filtern-Suchen-und-Zurücksetzen-auf.png)

🎬 [Video ansehen](media/057-handy-Tabellen-Sortieren-Filtern-Suchen-und-Zurücksetzen-auf.webm)

### ⏭️ Dashboard: Kennzahlen, Links und Agent-Aufgaben · handy

Status: skipped · Dauer 0.1 s

**Dashboard: Kennzahlen, Links und Agent-Aufgaben · handy (Ende)**

![Dashboard: Kennzahlen, Links und Agent-Aufgaben · handy (Ende)](media/058-handy-Dashboard-Kennzahlen-Links-und-Agent-Aufgaben-handy-En.png)

🎬 [Video ansehen](media/059-handy-Dashboard-Kennzahlen-Links-und-Agent-Aufgaben.webm)

### ⏭️ Auftrag: anlegen, Status ändern, erneut versuchen, analysieren, löschen · handy

Status: skipped · Dauer 0.2 s

**Auftrag: anlegen, Status ändern, erneut versuchen, analysieren, löschen · handy (Ende)**

![Auftrag: anlegen, Status ändern, erneut versuchen, analysieren, löschen · handy (Ende)](media/060-handy-Auftrag-anlegen-Status-ändern-erneut-versuchen-analysi.png)

🎬 [Video ansehen](media/061-handy-Auftrag-anlegen-Status-ändern-erneut-versuchen-analysi.webm)

### ⏭️ Ideen: anlegen, öffnen, kommentieren, Auftrag erstellen lassen · handy

Status: skipped · Dauer 0.2 s

**Ideen: anlegen, öffnen, kommentieren, Auftrag erstellen lassen · handy (Ende)**

![Ideen: anlegen, öffnen, kommentieren, Auftrag erstellen lassen · handy (Ende)](media/062-handy-Ideen-anlegen-öffnen-kommentieren-Auftrag-erstellen-la.png)

🎬 [Video ansehen](media/063-handy-Ideen-anlegen-öffnen-kommentieren-Auftrag-erstellen-la.webm)

### ⏭️ Bugs: anlegen, Status ändern, bearbeiten, löschen · handy

Status: skipped · Dauer 0.1 s

**Bugs: anlegen, Status ändern, bearbeiten, löschen · handy (Ende)**

![Bugs: anlegen, Status ändern, bearbeiten, löschen · handy (Ende)](media/064-handy-Bugs-anlegen-Status-ändern-bearbeiten-löschen-handy-En.png)

🎬 [Video ansehen](media/065-handy-Bugs-anlegen-Status-ändern-bearbeiten-löschen.webm)

### ⏭️ Sprints: Datum prüfen, anlegen, Board öffnen, starten · handy

Status: skipped · Dauer 0.2 s

**Sprints: Datum prüfen, anlegen, Board öffnen, starten · handy (Ende)**

![Sprints: Datum prüfen, anlegen, Board öffnen, starten · handy (Ende)](media/066-handy-Sprints-Datum-prüfen-anlegen-Board-öffnen-starten-hand.png)

🎬 [Video ansehen](media/067-handy-Sprints-Datum-prüfen-anlegen-Board-öffnen-starten.webm)

### ⏭️ Dokumentation: Markdown, bearbeiten, einreichen, freigeben, neues Handbuch · handy

Status: skipped · Dauer 0.2 s

**Dokumentation: Markdown, bearbeiten, einreichen, freigeben, neues Handbuch · handy (Ende)**

![Dokumentation: Markdown, bearbeiten, einreichen, freigeben, neues Handbuch · handy (Ende)](media/068-handy-Dokumentation-Markdown-bearbeiten-einreichen-freigeben.png)

🎬 [Video ansehen](media/069-handy-Dokumentation-Markdown-bearbeiten-einreichen-freigeben.webm)

### ⏭️ Agents: anlegen, Reihenfolge, aktivieren, Detailansicht · handy

Status: skipped · Dauer 0.2 s

**Agents: anlegen, Reihenfolge, aktivieren, Detailansicht · handy (Ende)**

![Agents: anlegen, Reihenfolge, aktivieren, Detailansicht · handy (Ende)](media/070-handy-Agents-anlegen-Reihenfolge-aktivieren-Detailansicht-ha.png)

🎬 [Video ansehen](media/071-handy-Agents-anlegen-Reihenfolge-aktivieren-Detailansicht.webm)

### ✅ Einstellungen: Validierungen, Benutzer anlegen, Projekt löschen gesperrt · handy

Status: passed · Dauer 1.5 s

**Projekt löschen (Handy)**

![Projekt löschen (Handy)](media/072-handy-Projekt-löschen-Handy.png)

**Einstellungen: Validierungen, Benutzer anlegen, Projekt löschen gesperrt · handy (Ende)**

![Einstellungen: Validierungen, Benutzer anlegen, Projekt löschen gesperrt · handy (Ende)](media/073-handy-Einstellungen-Validierungen-Benutzer-anlegen-Projekt-l.png)

🎬 [Video ansehen](media/074-handy-Einstellungen-Validierungen-Benutzer-anlegen-Projekt-l.webm)

### ⏭️ Projektwechsel trennt die Daten · handy

Status: skipped · Dauer 0.2 s

**Projektwechsel trennt die Daten · handy (Ende)**

![Projektwechsel trennt die Daten · handy (Ende)](media/075-handy-Projektwechsel-trennt-die-Daten-handy-Ende.png)

🎬 [Video ansehen](media/076-handy-Projektwechsel-trennt-die-Daten.webm)

### ❌ Rollen: Autorin sieht nur, was sie darf · handy

Status: failed · Dauer 16.5 s

**Befunde:**

- Ohne Chat-Rolle kein „Verlauf leeren“
- Ohne Agent-Rolle kein „Erneut versuchen“
- Ohne Agent-Verwaltung kein „Standard-Workflow anlegen“

**Ansicht der Autorin**

![Ansicht der Autorin](media/077-handy-Ansicht-der-Autorin.png)

**Rollen: Autorin sieht nur, was sie darf · handy (Ende)**

![Rollen: Autorin sieht nur, was sie darf · handy (Ende)](media/078-handy-Rollen-Autorin-sieht-nur-was-sie-darf-handy-Ende.png)

## Ausgabe fehlgeschlagener Prüfungen

<details><summary>Oberflächentest</summary>

```text
      617 |   await context.close();
        at /Volumes/External/DevLog/e2e/full-ui.check.ts:614:6

    attachment #1: Ansicht der Autorin (image/png) ─────────────────────────────────────────────────
    ../../../var/folders/_5/pb2f9t5159z03xw_4cy18rxr0000gn/T/dev-log-full-ui-2026-10-18_18-33/full-ui.check.ts-Rollen-Autorin-sieht-nur-was-sie-darf-handy/attachments/Ansicht-der-Autorin-471083cb5ffb50de76fbd5d7dd3553d72f56dbff.png
    ────────────────────────────────────────────────────────────────────────────────────────────────

    attachment #2: screenshot (image/png) ──────────────────────────────────────────────────────────
    ../../../var/folders/_5/pb2f9t5159z03xw_4cy18rxr0000gn/T/dev-log-full-ui-2026-10-18_18-33/full-ui.check.ts-Rollen-Autorin-sieht-nur-was-sie-darf-handy/test-failed-1.png
    ────────────────────────────────────────────────────────────────────────────────────────────────

    Error Context: ../../../var/folders/_5/pb2f9t5159z03xw_4cy18rxr0000gn/T/dev-log-full-ui-2026-10-18_18-33/full-ui.check.ts-Rollen-Autorin-sieht-nur-was-sie-darf-handy/error-context.md

  9 failed
    [desktop] › e2e/full-ui.check.ts:306:1 › Tabellen: Sortieren, Filtern, Suchen und Zurücksetzen auf allen Seiten 
    [desktop] › e2e/full-ui.check.ts:351:1 › Auftrag: anlegen, Status ändern, erneut versuchen, analysieren, löschen 
    [desktop] › e2e/full-ui.check.ts:393:1 › Ideen: anlegen, öffnen, kommentieren, Auftrag erstellen lassen 
    [desktop] › e2e/full-ui.check.ts:448:1 › Sprints: Datum prüfen, anlegen, Board öffnen, starten ─
    [desktop] › e2e/full-ui.check.ts:481:1 › Dokumentation: Markdown, bearbeiten, einreichen, freigeben, neues Handbuch 
    [desktop] › e2e/full-ui.check.ts:506:1 › Agents: anlegen, Reihenfolge, aktivieren, Detailansicht 
    [desktop] › e2e/full-ui.check.ts:579:1 › Projektwechsel trennt die Daten ───────────────────────
    [desktop] › e2e/full-ui.check.ts:597:1 › Rollen: Autorin sieht nur, was sie darf ───────────────
    [handy] › e2e/full-ui.check.ts:597:1 › Rollen: Autorin sieht nur, was sie darf ─────────────────
  9 skipped
  6 passed (2.7m)
```

</details>

