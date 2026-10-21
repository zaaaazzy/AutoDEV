# Testbericht 21.10.2026, 22:19:49

Erstellt mit `npm run test:full`. Gesamtergebnis: ❌ mit Befunden.
Der Oberflächentest läuft auf einer eigenen Testdatenbank (dev_log_full) ohne Worker: Agents, Chat-Antworten und der Projekt-Assistent starten dort nicht.
In AIdeation abgelegt: Projekt `dev-log`, Testlauf `56c90c38-4967-4aeb-aa6f-437c4d38c10c`.

## Übersicht

| Prüfung | Ergebnis | Dauer | Zusammenfassung |
|---|---|---|---|
| Lint | ✅ | 3 s | 529 problems (0 errors, 529 warnings) |
| Formatierung | ✅ | 4 s | alles formatiert |
| Typprüfung | ✅ | 3 s | Backend und Oberfläche |
| Unit-Tests (inkl. UI-Build) | ✅ | 21 s | 844 bestanden, 0 fehlgeschlagen, 5 Build-Warnungen |
| E2E-Tests | ✅ | 115 s | 53 passed, 3 skipped |
| Oberflächentest | ❌ | 247 s | 18 passed, 1 failed, 9 skipped |

## Befunde des Oberflächentests

| Gerät | Test | Befund |
|---|---|---|
| desktop | Sprints: Datum prüfen, anlegen, Aufträge zeigen, starten | expect(locator).toHaveText(expected) failed – Locator:  locator('.sprint-current').locator('.sprint-title h3') |

## Oberflächentest im Detail

### ✅ Alle Seiten laden ohne Fehler und ohne seitliches Überlaufen · desktop

Status: passed · Dauer 2.3 s

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

Status: passed · Dauer 2.0 s

**Agent-Aktionen**

![Agent-Aktionen](media/014-desktop-Agent-Aktionen.png)

**Agent-Aktion Verlauf**

![Agent-Aktion Verlauf](media/015-desktop-Agent-Aktion-Verlauf.png)

**Agent-Aktion Zeitplan**

![Agent-Aktion Zeitplan](media/016-desktop-Agent-Aktion-Zeitplan.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/017-desktop-Bildschirm-am-Ende.png)

### ✅ Auftrag: anlegen, Status ändern, erneut versuchen, analysieren, löschen · desktop

Status: passed · Dauer 2.0 s

**Neuer Auftrag geklickt**

![Neuer Auftrag geklickt](media/018-desktop-Neuer-Auftrag-geklickt.png)

**Auftrag Details**

![Auftrag Details](media/019-desktop-Auftrag-Details.png)

**Erneut versuchen bestätigen**

![Erneut versuchen bestätigen](media/020-desktop-Erneut-versuchen-bestätigen.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/021-desktop-Bildschirm-am-Ende.png)

### ✅ Ideen: anlegen, öffnen, kommentieren, Auftrag erstellen lassen · desktop

Status: passed · Dauer 1.8 s

**Idee mit Kommentar**

![Idee mit Kommentar](media/022-desktop-Idee-mit-Kommentar.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/023-desktop-Bildschirm-am-Ende.png)

### ✅ Bugs: anlegen, Status ändern, bearbeiten, löschen · desktop

Status: passed · Dauer 1.8 s

**Bug bearbeitet**

![Bug bearbeitet](media/024-desktop-Bug-bearbeitet.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/025-desktop-Bildschirm-am-Ende.png)

### ❌ Sprints: Datum prüfen, anlegen, Aufträge zeigen, starten · desktop

Status: failed · Dauer 6.8 s

**Befunde:**

- expect(locator).toHaveText(expected) failed – Locator:  locator('.sprint-current').locator('.sprint-title h3')

**Sprint-Aufträge**

![Sprint-Aufträge](media/026-desktop-Sprint-Aufträge.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/027-desktop-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/028-desktop-Sprints-Datum-prüfen-anlegen-Aufträge-zeigen-starten.webm)

### ✅ Dokumentation: Markdown, bearbeiten, einreichen, freigeben, neues Handbuch · desktop

Status: passed · Dauer 1.8 s

**Doku Architektur**

![Doku Architektur](media/029-desktop-Doku-Architektur.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/030-desktop-Bildschirm-am-Ende.png)

### ✅ Agents: anlegen, Reihenfolge, aktivieren, Detailansicht · desktop

Status: passed · Dauer 1.7 s

**Agent-Detail**

![Agent-Detail](media/031-desktop-Agent-Detail.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/032-desktop-Bildschirm-am-Ende.png)

### ✅ Agents: „Was machen die Rollen?“ auf- und zuklappen · desktop

Status: passed · Dauer 1.4 s

**Was machen die Rollen**

![Was machen die Rollen](media/033-desktop-Was-machen-die-Rollen.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/034-desktop-Bildschirm-am-Ende.png)

### ✅ Einstellungen: Validierungen, Benutzer anlegen, Projekt löschen gesperrt · desktop

Status: passed · Dauer 2.2 s

**Einstellungen**

![Einstellungen](media/035-desktop-Einstellungen.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/036-desktop-Bildschirm-am-Ende.png)

### ✅ Projektwechsel trennt die Daten · desktop

Status: passed · Dauer 1.7 s

**Bildschirm am Ende**

![Bildschirm am Ende](media/037-desktop-Bildschirm-am-Ende.png)

### ✅ Rollen: Autorin sieht nur, was sie darf · desktop

Status: passed · Dauer 1.3 s

**Ansicht der Autorin**

![Ansicht der Autorin](media/038-desktop-Ansicht-der-Autorin.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/039-desktop-Bildschirm-am-Ende.png)

### ✅ Jeder Knopf und Link: anklicken, Dialoge bearbeiten und speichern, ohne Fehler · desktop

Status: passed · Dauer 84.7 s

**Klicktest dashboard**

![Klicktest dashboard](media/040-desktop-Klicktest-dashboard.png)

**Klicktest actions**

![Klicktest actions](media/041-desktop-Klicktest-actions.png)

**Klicktest docs**

![Klicktest docs](media/042-desktop-Klicktest-docs.png)

**Klicktest ideation**

![Klicktest ideation](media/043-desktop-Klicktest-ideation.png)

**Klicktest development**

![Klicktest development](media/044-desktop-Klicktest-development.png)

**Klicktest sprints**

![Klicktest sprints](media/045-desktop-Klicktest-sprints.png)

**Klicktest bugs**

![Klicktest bugs](media/046-desktop-Klicktest-bugs.png)

**Klicktest runs**

![Klicktest runs](media/047-desktop-Klicktest-runs.png)

**Klicktest agents**

![Klicktest agents](media/048-desktop-Klicktest-agents.png)

**Klicktest stats**

![Klicktest stats](media/049-desktop-Klicktest-stats.png)

**Klicktest settings**

![Klicktest settings](media/050-desktop-Klicktest-settings.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/051-desktop-Bildschirm-am-Ende.png)

### ✅ Alle Seiten laden ohne Fehler und ohne seitliches Überlaufen · handy

Status: passed · Dauer 3.6 s

**dashboard (Handy)**

![dashboard (Handy)](media/052-handy-dashboard-Handy.png)

**actions (Handy)**

![actions (Handy)](media/053-handy-actions-Handy.png)

**docs (Handy)**

![docs (Handy)](media/054-handy-docs-Handy.png)

**ideation (Handy)**

![ideation (Handy)](media/055-handy-ideation-Handy.png)

**development (Handy)**

![development (Handy)](media/056-handy-development-Handy.png)

**sprints (Handy)**

![sprints (Handy)](media/057-handy-sprints-Handy.png)

**bugs (Handy)**

![bugs (Handy)](media/058-handy-bugs-Handy.png)

**runs (Handy)**

![runs (Handy)](media/059-handy-runs-Handy.png)

**agents (Handy)**

![agents (Handy)](media/060-handy-agents-Handy.png)

**stats (Handy)**

![stats (Handy)](media/061-handy-stats-Handy.png)

**settings (Handy)**

![settings (Handy)](media/062-handy-settings-Handy.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/063-handy-Bildschirm-am-Ende.png)

### ⏭️ Tabellen: Sortieren, Filtern, Suchen und Zurücksetzen auf allen Seiten · handy

Status: skipped · Dauer 0.2 s

**Bildschirm am Ende**

![Bildschirm am Ende](media/064-handy-Bildschirm-am-Ende.png)

### ⏭️ Dashboard: Kennzahlen, Links und Agent-Aktionen · handy

Status: skipped · Dauer 0.2 s

**Bildschirm am Ende**

![Bildschirm am Ende](media/065-handy-Bildschirm-am-Ende.png)

### ⏭️ Auftrag: anlegen, Status ändern, erneut versuchen, analysieren, löschen · handy

Status: skipped · Dauer 0.2 s

**Bildschirm am Ende**

![Bildschirm am Ende](media/066-handy-Bildschirm-am-Ende.png)

### ⏭️ Ideen: anlegen, öffnen, kommentieren, Auftrag erstellen lassen · handy

Status: skipped · Dauer 0.2 s

**Bildschirm am Ende**

![Bildschirm am Ende](media/067-handy-Bildschirm-am-Ende.png)

### ⏭️ Bugs: anlegen, Status ändern, bearbeiten, löschen · handy

Status: skipped · Dauer 0.1 s

**Bildschirm am Ende**

![Bildschirm am Ende](media/068-handy-Bildschirm-am-Ende.png)

### ⏭️ Sprints: Datum prüfen, anlegen, Aufträge zeigen, starten · handy

Status: skipped · Dauer 0.2 s

**Bildschirm am Ende**

![Bildschirm am Ende](media/069-handy-Bildschirm-am-Ende.png)

### ⏭️ Dokumentation: Markdown, bearbeiten, einreichen, freigeben, neues Handbuch · handy

Status: skipped · Dauer 0.2 s

**Bildschirm am Ende**

![Bildschirm am Ende](media/070-handy-Bildschirm-am-Ende.png)

### ⏭️ Agents: anlegen, Reihenfolge, aktivieren, Detailansicht · handy

Status: skipped · Dauer 0.2 s

**Bildschirm am Ende**

![Bildschirm am Ende](media/071-handy-Bildschirm-am-Ende.png)

### ✅ Agents: „Was machen die Rollen?“ auf- und zuklappen · handy

Status: passed · Dauer 1.6 s

**Was machen die Rollen**

![Was machen die Rollen](media/072-handy-Was-machen-die-Rollen.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/073-handy-Bildschirm-am-Ende.png)

### ✅ Einstellungen: Validierungen, Benutzer anlegen, Projekt löschen gesperrt · handy

Status: passed · Dauer 1.6 s

**Projekt löschen (Handy)**

![Projekt löschen (Handy)](media/074-handy-Projekt-löschen-Handy.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/075-handy-Bildschirm-am-Ende.png)

### ⏭️ Projektwechsel trennt die Daten · handy

Status: skipped · Dauer 0.2 s

**Bildschirm am Ende**

![Bildschirm am Ende](media/076-handy-Bildschirm-am-Ende.png)

### ✅ Rollen: Autorin sieht nur, was sie darf · handy

Status: passed · Dauer 1.4 s

**Ansicht der Autorin**

![Ansicht der Autorin](media/077-handy-Ansicht-der-Autorin.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/078-handy-Bildschirm-am-Ende.png)

### ✅ Jeder Knopf und Link: anklicken, Dialoge bearbeiten und speichern, ohne Fehler · handy

Status: passed · Dauer 60.4 s

**Klicktest dashboard (Handy)**

![Klicktest dashboard (Handy)](media/079-handy-Klicktest-dashboard-Handy.png)

**Klicktest actions (Handy)**

![Klicktest actions (Handy)](media/080-handy-Klicktest-actions-Handy.png)

**Klicktest docs (Handy)**

![Klicktest docs (Handy)](media/081-handy-Klicktest-docs-Handy.png)

**Klicktest ideation (Handy)**

![Klicktest ideation (Handy)](media/082-handy-Klicktest-ideation-Handy.png)

**Klicktest development (Handy)**

![Klicktest development (Handy)](media/083-handy-Klicktest-development-Handy.png)

**Klicktest sprints (Handy)**

![Klicktest sprints (Handy)](media/084-handy-Klicktest-sprints-Handy.png)

**Klicktest bugs (Handy)**

![Klicktest bugs (Handy)](media/085-handy-Klicktest-bugs-Handy.png)

**Klicktest runs (Handy)**

![Klicktest runs (Handy)](media/086-handy-Klicktest-runs-Handy.png)

**Klicktest agents (Handy)**

![Klicktest agents (Handy)](media/087-handy-Klicktest-agents-Handy.png)

**Klicktest stats (Handy)**

![Klicktest stats (Handy)](media/088-handy-Klicktest-stats-Handy.png)

**Klicktest settings (Handy)**

![Klicktest settings (Handy)](media/089-handy-Klicktest-settings-Handy.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/090-handy-Bildschirm-am-Ende.png)

## Ausgabe fehlgeschlagener Prüfungen

<details><summary>Oberflächentest</summary>

```text

    Locator:  locator('.sprint-current').locator('.sprint-title h3')
    Expected: "Sprint 1"
    Received: "Sprint Test 6971"
    Timeout:  5000ms

    Call log:
      - Expect "toHaveText" locator('.sprint-current').locator('.sprint-title h3') with timeout 5000ms
      - waiting for locator('.sprint-current').locator('.sprint-title h3')
        14 × locator resolved to <h3>Sprint Test 6971</h3>
           - unexpected value "Sprint Test 6971"


      567 |   // Gestartet ist er der aktuelle Sprint und steht oben.
      568 |   const current = page.locator('.sprint-current');
    > 569 |   await expect(current.locator('.sprint-title h3')).toHaveText('Sprint 1');
          |                                                     ^
      570 |   await expect(current.locator('.sprint-title .status').first()).toContainText('Aktiv');
      571 |   await expect
      572 |     .soft(current.locator('.detail-list > div').first().locator('dd'), '„Sprint starten“ setzt das Startdatum')
        at /Volumes/DroneShots/Coding/AIdeation-zeilen/e2e/full-ui.check.ts:569:53

    attachment #1: Sprint-Aufträge (image/png) ─────────────────────────────────────────────────────
    ../../../../var/folders/_5/pb2f9t5159z03xw_4cy18rxr0000gn/T/dev-log-test-full-2026-10-21_22-19/user/full-ui.check.ts-Sprints-D-690c7-gen-Aufträge-zeigen-starten-desktop/attachments/Sprint-Aufträge-8e21d511bf094777a6af4f5227758ac42baaa34b.png
    ────────────────────────────────────────────────────────────────────────────────────────────────

    attachment #2: screenshot (image/png) ──────────────────────────────────────────────────────────
    ../../../../var/folders/_5/pb2f9t5159z03xw_4cy18rxr0000gn/T/dev-log-test-full-2026-10-21_22-19/user/full-ui.check.ts-Sprints-D-690c7-gen-Aufträge-zeigen-starten-desktop/test-failed-1.png
    ────────────────────────────────────────────────────────────────────────────────────────────────

    attachment #3: video (video/webm) ──────────────────────────────────────────────────────────────
    ../../../../var/folders/_5/pb2f9t5159z03xw_4cy18rxr0000gn/T/dev-log-test-full-2026-10-21_22-19/user/full-ui.check.ts-Sprints-D-690c7-gen-Aufträge-zeigen-starten-desktop/video.webm
    ────────────────────────────────────────────────────────────────────────────────────────────────

    Error Context: ../../../../var/folders/_5/pb2f9t5159z03xw_4cy18rxr0000gn/T/dev-log-test-full-2026-10-21_22-19/user/full-ui.check.ts-Sprints-D-690c7-gen-Aufträge-zeigen-starten-desktop/error-context.md

  1 failed
    [desktop] › e2e/full-ui.check.ts:547:1 › Sprints: Datum prüfen, anlegen, Aufträge zeigen, starten 
  9 skipped
  18 passed (4.1m)
```

</details>

