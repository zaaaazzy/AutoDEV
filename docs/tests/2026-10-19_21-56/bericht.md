# Testbericht 19.10.2026, 21:56:07

Erstellt mit `npm run test:full`. Gesamtergebnis: ❌ mit Befunden.
Der Oberflächentest läuft auf einer eigenen Testdatenbank (dev_log_full) ohne Worker: Agents, Chat-Antworten und der Projekt-Assistent starten dort nicht.
In Dev Log abgelegt: Projekt `dev-log`, Testlauf `d8ff2195-37db-4734-91b4-3923cb0e70cc`.

## Übersicht

| Prüfung | Ergebnis | Dauer | Zusammenfassung |
|---|---|---|---|
| Lint | ✅ | 2 s | 151 problems (0 errors, 151 warnings) |
| Formatierung | ✅ | 3 s | alles formatiert |
| Typprüfung | ✅ | 3 s | Backend und Oberfläche |
| Unit-Tests (inkl. UI-Build) | ✅ | 13 s | 184 bestanden, 0 fehlgeschlagen, 3 Build-Warnungen |
| E2E-Tests | ✅ | 46 s | 39 passed, 1 skipped |
| Oberflächentest | ❌ | 155 s | 8 passed, 7 failed, 9 skipped |

## Befunde des Oberflächentests

| Gerät | Test | Befund |
|---|---|---|
| desktop | Tabellen: Sortieren, Filtern, Suchen und Zurücksetzen auf allen Seiten | ideation · Tabelle „Alle Ideen“: Textfilter „Titel“ hat Fokus – |
| desktop | Tabellen: Sortieren, Filtern, Suchen und Zurücksetzen auf allen Seiten | development · Tabelle „Aufträge“: Textfilter „Titel“ hat Fokus – |
| desktop | Tabellen: Sortieren, Filtern, Suchen und Zurücksetzen auf allen Seiten | sprints · Tabelle „Sprints“: Textfilter „Sprint“ hat Fokus – |
| desktop | Tabellen: Sortieren, Filtern, Suchen und Zurücksetzen auf allen Seiten | bugs · Tabelle „Bugs“: Textfilter „Titel“ hat Fokus – |
| desktop | Tabellen: Sortieren, Filtern, Suchen und Zurücksetzen auf allen Seiten | runs · Tabelle „Verlauf“: Erster Klick auf „Gestartet“ sortiert (einheitlich) – Klickfolge →ascending→descending |
| desktop | Tabellen: Sortieren, Filtern, Suchen und Zurücksetzen auf allen Seiten | agents · Tabelle „Agents & Workflow“: Textfilter „Agent“ hat Fokus – |
| desktop | Tabellen: Sortieren, Filtern, Suchen und Zurücksetzen auf allen Seiten | stats · Tabelle „Schätzung gegen tatsächlich“: Textfilter „Auftrag“ hat Fokus – |
| desktop | Dashboard: Kennzahlen, Links und Agent-Aufgaben | TimeoutError: locator.click: Timeout 15000ms exceeded. – waiting for getByRole('button', { name: 'Aufgaben', exact: true }).first() |
| desktop | Auftrag: anlegen, Status ändern, erneut versuchen, analysieren, löschen | Formular „Neuer Auftrag“ erscheint im sichtbaren Bereich |
| desktop | Ideen: anlegen, öffnen, kommentieren, Auftrag erstellen lassen | TimeoutError: locator.click: Timeout 15000ms exceeded. – waiting for getByRole('button', { name: 'Kommentieren', exact: true }).first() |
| desktop | Sprints: Datum prüfen, anlegen, Board öffnen, starten | „Sprint starten“ setzt das Startdatum |
| desktop | Agents: anlegen, Reihenfolge, aktivieren, Detailansicht | Detail bleibt nach ↑ offen |
| desktop | Agents: anlegen, Reihenfolge, aktivieren, Detailansicht | Kein doppeltes „Sprint Sprint“ |
| desktop | Agents: anlegen, Reihenfolge, aktivieren, Detailansicht | Zurück-Button führt zur Agent-Liste |
| desktop | Projektwechsel trennt die Daten | Leertext ohne Filter spricht nicht von Filtern |

## Oberflächentest im Detail

### ✅ Alle Seiten laden ohne Fehler und ohne seitliches Überlaufen · desktop

Status: passed · Dauer 2.9 s

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

### ❌ Tabellen: Sortieren, Filtern, Suchen und Zurücksetzen auf allen Seiten · desktop

Status: failed · Dauer 54.4 s

**Befunde:**

- ideation · Tabelle „Alle Ideen“: Textfilter „Titel“ hat Fokus –
- development · Tabelle „Aufträge“: Textfilter „Titel“ hat Fokus –
- sprints · Tabelle „Sprints“: Textfilter „Sprint“ hat Fokus –
- bugs · Tabelle „Bugs“: Textfilter „Titel“ hat Fokus –
- runs · Tabelle „Verlauf“: Erster Klick auf „Gestartet“ sortiert (einheitlich) – Klickfolge →ascending→descending
- agents · Tabelle „Agents & Workflow“: Textfilter „Agent“ hat Fokus –
- stats · Tabelle „Schätzung gegen tatsächlich“: Textfilter „Auftrag“ hat Fokus –

**Bildschirm am Ende**

![Bildschirm am Ende](media/013-desktop-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/014-desktop-Tabellen-Sortieren-Filtern-Suchen-und-Zurücksetzen-a.webm)

### ❌ Dashboard: Kennzahlen, Links und Agent-Aufgaben · desktop

Status: failed · Dauer 17.8 s

**Befunde:**

- TimeoutError: locator.click: Timeout 15000ms exceeded. – waiting for getByRole('button', { name: 'Aufgaben', exact: true }).first()

**Bildschirm am Ende**

![Bildschirm am Ende](media/015-desktop-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/016-desktop-Dashboard-Kennzahlen-Links-und-Agent-Aufgaben.webm)

### ❌ Auftrag: anlegen, Status ändern, erneut versuchen, analysieren, löschen · desktop

Status: failed · Dauer 7.2 s

**Befunde:**

- Formular „Neuer Auftrag“ erscheint im sichtbaren Bereich

**Neuer Auftrag geklickt**

![Neuer Auftrag geklickt](media/017-desktop-Neuer-Auftrag-geklickt.png)

**Auftrag Details**

![Auftrag Details](media/018-desktop-Auftrag-Details.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/019-desktop-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/020-desktop-Auftrag-anlegen-Status-ändern-erneut-versuchen-analy.webm)

### ❌ Ideen: anlegen, öffnen, kommentieren, Auftrag erstellen lassen · desktop

Status: failed · Dauer 16.9 s

**Befunde:**

- TimeoutError: locator.click: Timeout 15000ms exceeded. – waiting for getByRole('button', { name: 'Kommentieren', exact: true }).first()

**Bildschirm am Ende**

![Bildschirm am Ende](media/021-desktop-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/022-desktop-Ideen-anlegen-öffnen-kommentieren-Auftrag-erstellen-.webm)

### ✅ Bugs: anlegen, Status ändern, bearbeiten, löschen · desktop

Status: passed · Dauer 2.3 s

**Bug bearbeitet**

![Bug bearbeitet](media/023-desktop-Bug-bearbeitet.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/024-desktop-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/025-desktop-Bugs-anlegen-Status-ändern-bearbeiten-löschen.webm)

### ❌ Sprints: Datum prüfen, anlegen, Board öffnen, starten · desktop

Status: failed · Dauer 7.2 s

**Befunde:**

- „Sprint starten“ setzt das Startdatum

**Sprint-Board**

![Sprint-Board](media/026-desktop-Sprint-Board.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/027-desktop-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/028-desktop-Sprints-Datum-prüfen-anlegen-Board-öffnen-starten.webm)

### ✅ Dokumentation: Markdown, bearbeiten, einreichen, freigeben, neues Handbuch · desktop

Status: passed · Dauer 2.1 s

**Doku Architektur**

![Doku Architektur](media/029-desktop-Doku-Architektur.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/030-desktop-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/031-desktop-Dokumentation-Markdown-bearbeiten-einreichen-freigeb.webm)

### ❌ Agents: anlegen, Reihenfolge, aktivieren, Detailansicht · desktop

Status: failed · Dauer 17.9 s

**Befunde:**

- Detail bleibt nach ↑ offen
- Kein doppeltes „Sprint Sprint“
- Zurück-Button führt zur Agent-Liste

**Agent-Detail**

![Agent-Detail](media/032-desktop-Agent-Detail.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/033-desktop-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/034-desktop-Agents-anlegen-Reihenfolge-aktivieren-Detailansicht.webm)

### ✅ Einstellungen: Validierungen, Benutzer anlegen, Projekt löschen gesperrt · desktop

Status: passed · Dauer 2.7 s

**Einstellungen**

![Einstellungen](media/035-desktop-Einstellungen.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/036-desktop-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/037-desktop-Einstellungen-Validierungen-Benutzer-anlegen-Projekt.webm)

### ❌ Projektwechsel trennt die Daten · desktop

Status: failed · Dauer 6.8 s

**Befunde:**

- Leertext ohne Filter spricht nicht von Filtern

**Bildschirm am Ende**

![Bildschirm am Ende](media/038-desktop-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/039-desktop-Projektwechsel-trennt-die-Daten.webm)

### ✅ Rollen: Autorin sieht nur, was sie darf · desktop

Status: passed · Dauer 1.5 s

**Ansicht der Autorin**

![Ansicht der Autorin](media/040-desktop-Ansicht-der-Autorin.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/041-desktop-Bildschirm-am-Ende.png)

### ✅ Alle Seiten laden ohne Fehler und ohne seitliches Überlaufen · handy

Status: passed · Dauer 4.7 s

**dashboard (Handy)**

![dashboard (Handy)](media/042-handy-dashboard-Handy.png)

**docs (Handy)**

![docs (Handy)](media/043-handy-docs-Handy.png)

**ideation (Handy)**

![ideation (Handy)](media/044-handy-ideation-Handy.png)

**development (Handy)**

![development (Handy)](media/045-handy-development-Handy.png)

**sprints (Handy)**

![sprints (Handy)](media/046-handy-sprints-Handy.png)

**bugs (Handy)**

![bugs (Handy)](media/047-handy-bugs-Handy.png)

**runs (Handy)**

![runs (Handy)](media/048-handy-runs-Handy.png)

**agents (Handy)**

![agents (Handy)](media/049-handy-agents-Handy.png)

**stats (Handy)**

![stats (Handy)](media/050-handy-stats-Handy.png)

**settings (Handy)**

![settings (Handy)](media/051-handy-settings-Handy.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/052-handy-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/053-handy-Alle-Seiten-laden-ohne-Fehler-und-ohne-seitliches-Über.webm)

### ⏭️ Tabellen: Sortieren, Filtern, Suchen und Zurücksetzen auf allen Seiten · handy

Status: skipped · Dauer 0.2 s

**Bildschirm am Ende**

![Bildschirm am Ende](media/054-handy-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/055-handy-Tabellen-Sortieren-Filtern-Suchen-und-Zurücksetzen-auf.webm)

### ⏭️ Dashboard: Kennzahlen, Links und Agent-Aufgaben · handy

Status: skipped · Dauer 0.1 s

**Bildschirm am Ende**

![Bildschirm am Ende](media/056-handy-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/057-handy-Dashboard-Kennzahlen-Links-und-Agent-Aufgaben.webm)

### ⏭️ Auftrag: anlegen, Status ändern, erneut versuchen, analysieren, löschen · handy

Status: skipped · Dauer 0.2 s

**Bildschirm am Ende**

![Bildschirm am Ende](media/058-handy-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/059-handy-Auftrag-anlegen-Status-ändern-erneut-versuchen-analysi.webm)

### ⏭️ Ideen: anlegen, öffnen, kommentieren, Auftrag erstellen lassen · handy

Status: skipped · Dauer 0.1 s

**Bildschirm am Ende**

![Bildschirm am Ende](media/060-handy-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/061-handy-Ideen-anlegen-öffnen-kommentieren-Auftrag-erstellen-la.webm)

### ⏭️ Bugs: anlegen, Status ändern, bearbeiten, löschen · handy

Status: skipped · Dauer 0.1 s

**Bildschirm am Ende**

![Bildschirm am Ende](media/062-handy-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/063-handy-Bugs-anlegen-Status-ändern-bearbeiten-löschen.webm)

### ⏭️ Sprints: Datum prüfen, anlegen, Board öffnen, starten · handy

Status: skipped · Dauer 0.2 s

**Bildschirm am Ende**

![Bildschirm am Ende](media/064-handy-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/065-handy-Sprints-Datum-prüfen-anlegen-Board-öffnen-starten.webm)

### ⏭️ Dokumentation: Markdown, bearbeiten, einreichen, freigeben, neues Handbuch · handy

Status: skipped · Dauer 0.2 s

**Bildschirm am Ende**

![Bildschirm am Ende](media/066-handy-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/067-handy-Dokumentation-Markdown-bearbeiten-einreichen-freigeben.webm)

### ⏭️ Agents: anlegen, Reihenfolge, aktivieren, Detailansicht · handy

Status: skipped · Dauer 0.2 s

**Bildschirm am Ende**

![Bildschirm am Ende](media/068-handy-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/069-handy-Agents-anlegen-Reihenfolge-aktivieren-Detailansicht.webm)

### ✅ Einstellungen: Validierungen, Benutzer anlegen, Projekt löschen gesperrt · handy

Status: passed · Dauer 1.6 s

**Projekt löschen (Handy)**

![Projekt löschen (Handy)](media/070-handy-Projekt-löschen-Handy.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/071-handy-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/072-handy-Einstellungen-Validierungen-Benutzer-anlegen-Projekt-l.webm)

### ⏭️ Projektwechsel trennt die Daten · handy

Status: skipped · Dauer 0.2 s

**Bildschirm am Ende**

![Bildschirm am Ende](media/073-handy-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/074-handy-Projektwechsel-trennt-die-Daten.webm)

### ✅ Rollen: Autorin sieht nur, was sie darf · handy

Status: passed · Dauer 1.3 s

**Ansicht der Autorin**

![Ansicht der Autorin](media/075-handy-Ansicht-der-Autorin.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/076-handy-Bildschirm-am-Ende.png)

## Ausgabe fehlgeschlagener Prüfungen

<details><summary>Oberflächentest</summary>

```text
      593 |   await page.getByRole('button', { name: 'Projekt wechseln' }).click();
      594 |   await page.getByRole('option', { name: /Alpha Shop/ }).click();
      595 | });
        at /Volumes/DroneShots/Coding/DevLog-agents/e2e/full-ui.check.ts:592:10

    attachment #1: screenshot (image/png) ──────────────────────────────────────────────────────────
    ../../../../var/folders/_5/pb2f9t5159z03xw_4cy18rxr0000gn/T/dev-log-test-full-2026-10-19_21-56/user/full-ui.check.ts-Projektwechsel-trennt-die-Daten-desktop/test-failed-1.png
    ────────────────────────────────────────────────────────────────────────────────────────────────

    attachment #2: video (video/webm) ──────────────────────────────────────────────────────────────
    ../../../../var/folders/_5/pb2f9t5159z03xw_4cy18rxr0000gn/T/dev-log-test-full-2026-10-19_21-56/user/full-ui.check.ts-Projektwechsel-trennt-die-Daten-desktop/video.webm
    ────────────────────────────────────────────────────────────────────────────────────────────────

    Error Context: ../../../../var/folders/_5/pb2f9t5159z03xw_4cy18rxr0000gn/T/dev-log-test-full-2026-10-19_21-56/user/full-ui.check.ts-Projektwechsel-trennt-die-Daten-desktop/error-context.md

  7 failed
    [desktop] › e2e/full-ui.check.ts:306:1 › Tabellen: Sortieren, Filtern, Suchen und Zurücksetzen auf allen Seiten 
    [desktop] › e2e/full-ui.check.ts:330:1 › Dashboard: Kennzahlen, Links und Agent-Aufgaben ───────
    [desktop] › e2e/full-ui.check.ts:351:1 › Auftrag: anlegen, Status ändern, erneut versuchen, analysieren, löschen 
    [desktop] › e2e/full-ui.check.ts:393:1 › Ideen: anlegen, öffnen, kommentieren, Auftrag erstellen lassen 
    [desktop] › e2e/full-ui.check.ts:448:1 › Sprints: Datum prüfen, anlegen, Board öffnen, starten ─
    [desktop] › e2e/full-ui.check.ts:506:1 › Agents: anlegen, Reihenfolge, aktivieren, Detailansicht 
    [desktop] › e2e/full-ui.check.ts:579:1 › Projektwechsel trennt die Daten ───────────────────────
  9 skipped
  8 passed (2.6m)
```

</details>

