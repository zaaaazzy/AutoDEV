# Testbericht 21.10.2026, 17:53:20

Erstellt mit `npm run test:full`. Gesamtergebnis: ❌ mit Befunden.
Der Oberflächentest läuft auf einer eigenen Testdatenbank (dev_log_full) ohne Worker: Agents, Chat-Antworten und der Projekt-Assistent starten dort nicht.


## Übersicht

| Prüfung | Ergebnis | Dauer | Zusammenfassung |
|---|---|---|---|
| Lint | ✅ | 3 s | 503 problems (0 errors, 503 warnings) |
| Formatierung | ✅ | 4 s | alles formatiert |
| Typprüfung | ✅ | 3 s | Backend und Oberfläche |
| Unit-Tests (inkl. UI-Build) | ❌ | 24 s | 862 bestanden, 1 fehlgeschlagen, 5 Build-Warnungen |
| E2E-Tests | ✅ | 77 s | 52 passed, 2 skipped |
| Oberflächentest | ❌ | 149 s | 4 passed, 2 failed, 9 skipped |

## Befunde des Oberflächentests

| Gerät | Test | Befund |
|---|---|---|
| desktop | Alle Seiten laden ohne Fehler und ohne seitliches Überlaufen | PATCH /api/development/305f3d0b-223b-443e-bc18-64b4fe2054ee: {"message":"Status change backlog → in_progress is not allowed manually; it is set by the worker or a dedicated action."} |
| handy | Rollen: Autorin sieht nur, was sie darf | expect(locator).toBeVisible() failed – Locator: locator('.app-shell') |

## Oberflächentest im Detail

### ❌ Alle Seiten laden ohne Fehler und ohne seitliches Überlaufen · desktop

Status: failed · Dauer 0.0 s

**Befunde:**

- PATCH /api/development/305f3d0b-223b-443e-bc18-64b4fe2054ee: {"message":"Status change backlog → in_progress is not allowed manually; it is set by the worker or a dedicated action."}

### ⏭️ Tabellen: Sortieren, Filtern, Suchen und Zurücksetzen auf allen Seiten · desktop

Status: skipped · Dauer 0.0 s

### ⏭️ Dashboard: Kennzahlen, Links und Agent-Aktionen · desktop

Status: skipped · Dauer 0.0 s

### ⏭️ Auftrag: anlegen, Status ändern, erneut versuchen, analysieren, löschen · desktop

Status: skipped · Dauer 0.0 s

### ⏭️ Ideen: anlegen, öffnen, kommentieren, Auftrag erstellen lassen · desktop

Status: skipped · Dauer 0.0 s

### ⏭️ Bugs: anlegen, Status ändern, bearbeiten, löschen · desktop

Status: skipped · Dauer 0.0 s

### ⏭️ Sprints: Datum prüfen, anlegen, Board öffnen, starten · desktop

Status: skipped · Dauer 0.0 s

### ⏭️ Dokumentation: Markdown, bearbeiten, einreichen, freigeben, neues Handbuch · desktop

Status: skipped · Dauer 0.0 s

### ⏭️ Agents: anlegen, Reihenfolge, aktivieren, Detailansicht · desktop

Status: skipped · Dauer 0.0 s

### ⏭️ Agents: „Was machen die Rollen?“ auf- und zuklappen · desktop

Status: skipped · Dauer 0.0 s

### ⏭️ Einstellungen: Validierungen, Benutzer anlegen, Projekt löschen gesperrt · desktop

Status: skipped · Dauer 0.0 s

### ⏭️ Projektwechsel trennt die Daten · desktop

Status: skipped · Dauer 0.0 s

### ⏭️ Rollen: Autorin sieht nur, was sie darf · desktop

Status: skipped · Dauer 0.0 s

### ⏭️ Jeder Knopf und Link: anklicken, Dialoge bearbeiten und speichern, ohne Fehler · desktop

Status: skipped · Dauer 0.0 s

### ✅ Alle Seiten laden ohne Fehler und ohne seitliches Überlaufen · handy

Status: passed · Dauer 5.0 s

**dashboard (Handy)**

![dashboard (Handy)](media/001-handy-dashboard-Handy.png)

**actions (Handy)**

![actions (Handy)](media/002-handy-actions-Handy.png)

**docs (Handy)**

![docs (Handy)](media/003-handy-docs-Handy.png)

**ideation (Handy)**

![ideation (Handy)](media/004-handy-ideation-Handy.png)

**development (Handy)**

![development (Handy)](media/005-handy-development-Handy.png)

**sprints (Handy)**

![sprints (Handy)](media/006-handy-sprints-Handy.png)

**bugs (Handy)**

![bugs (Handy)](media/007-handy-bugs-Handy.png)

**runs (Handy)**

![runs (Handy)](media/008-handy-runs-Handy.png)

**agents (Handy)**

![agents (Handy)](media/009-handy-agents-Handy.png)

**stats (Handy)**

![stats (Handy)](media/010-handy-stats-Handy.png)

**settings (Handy)**

![settings (Handy)](media/011-handy-settings-Handy.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/012-handy-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/013-handy-Alle-Seiten-laden-ohne-Fehler-und-ohne-seitliches-Über.webm)

### ⏭️ Tabellen: Sortieren, Filtern, Suchen und Zurücksetzen auf allen Seiten · handy

Status: skipped · Dauer 0.3 s

**Bildschirm am Ende**

![Bildschirm am Ende](media/014-handy-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/015-handy-Tabellen-Sortieren-Filtern-Suchen-und-Zurücksetzen-auf.webm)

### ⏭️ Dashboard: Kennzahlen, Links und Agent-Aktionen · handy

Status: skipped · Dauer 0.1 s

**Bildschirm am Ende**

![Bildschirm am Ende](media/016-handy-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/017-handy-Dashboard-Kennzahlen-Links-und-Agent-Aktionen.webm)

### ⏭️ Auftrag: anlegen, Status ändern, erneut versuchen, analysieren, löschen · handy

Status: skipped · Dauer 0.2 s

**Bildschirm am Ende**

![Bildschirm am Ende](media/018-handy-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/019-handy-Auftrag-anlegen-Status-ändern-erneut-versuchen-analysi.webm)

### ⏭️ Ideen: anlegen, öffnen, kommentieren, Auftrag erstellen lassen · handy

Status: skipped · Dauer 0.1 s

**Bildschirm am Ende**

![Bildschirm am Ende](media/020-handy-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/021-handy-Ideen-anlegen-öffnen-kommentieren-Auftrag-erstellen-la.webm)

### ⏭️ Bugs: anlegen, Status ändern, bearbeiten, löschen · handy

Status: skipped · Dauer 0.2 s

**Bildschirm am Ende**

![Bildschirm am Ende](media/022-handy-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/023-handy-Bugs-anlegen-Status-ändern-bearbeiten-löschen.webm)

### ⏭️ Sprints: Datum prüfen, anlegen, Board öffnen, starten · handy

Status: skipped · Dauer 0.2 s

**Bildschirm am Ende**

![Bildschirm am Ende](media/024-handy-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/025-handy-Sprints-Datum-prüfen-anlegen-Board-öffnen-starten.webm)

### ⏭️ Dokumentation: Markdown, bearbeiten, einreichen, freigeben, neues Handbuch · handy

Status: skipped · Dauer 0.2 s

**Bildschirm am Ende**

![Bildschirm am Ende](media/026-handy-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/027-handy-Dokumentation-Markdown-bearbeiten-einreichen-freigeben.webm)

### ⏭️ Agents: anlegen, Reihenfolge, aktivieren, Detailansicht · handy

Status: skipped · Dauer 0.3 s

**Bildschirm am Ende**

![Bildschirm am Ende](media/028-handy-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/029-handy-Agents-anlegen-Reihenfolge-aktivieren-Detailansicht.webm)

### ✅ Agents: „Was machen die Rollen?“ auf- und zuklappen · handy

Status: passed · Dauer 2.0 s

**Was machen die Rollen**

![Was machen die Rollen](media/030-handy-Was-machen-die-Rollen.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/031-handy-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/032-handy-Agents-Was-machen-die-Rollen-auf-und-zuklappen.webm)

### ✅ Einstellungen: Validierungen, Benutzer anlegen, Projekt löschen gesperrt · handy

Status: passed · Dauer 1.8 s

**Projekt löschen (Handy)**

![Projekt löschen (Handy)](media/033-handy-Projekt-löschen-Handy.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/034-handy-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/035-handy-Einstellungen-Validierungen-Benutzer-anlegen-Projekt-l.webm)

### ⏭️ Projektwechsel trennt die Daten · handy

Status: skipped · Dauer 0.3 s

**Bildschirm am Ende**

![Bildschirm am Ende](media/036-handy-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/037-handy-Projektwechsel-trennt-die-Daten.webm)

### ❌ Rollen: Autorin sieht nur, was sie darf · handy

Status: failed · Dauer 6.1 s

**Befunde:**

- expect(locator).toBeVisible() failed – Locator: locator('.app-shell')

**Bildschirm am Ende**

![Bildschirm am Ende](media/038-handy-Bildschirm-am-Ende.png)

### ✅ Jeder Knopf und Link: anklicken, Dialoge bearbeiten und speichern, ohne Fehler · handy

Status: passed · Dauer 129.0 s

**Klicktest dashboard (Handy)**

![Klicktest dashboard (Handy)](media/039-handy-Klicktest-dashboard-Handy.png)

**Klicktest actions (Handy)**

![Klicktest actions (Handy)](media/040-handy-Klicktest-actions-Handy.png)

**Klicktest docs (Handy)**

![Klicktest docs (Handy)](media/041-handy-Klicktest-docs-Handy.png)

**Klicktest ideation (Handy)**

![Klicktest ideation (Handy)](media/042-handy-Klicktest-ideation-Handy.png)

**Klicktest development (Handy)**

![Klicktest development (Handy)](media/043-handy-Klicktest-development-Handy.png)

**Klicktest sprints (Handy)**

![Klicktest sprints (Handy)](media/044-handy-Klicktest-sprints-Handy.png)

**Klicktest bugs (Handy)**

![Klicktest bugs (Handy)](media/045-handy-Klicktest-bugs-Handy.png)

**Klicktest runs (Handy)**

![Klicktest runs (Handy)](media/046-handy-Klicktest-runs-Handy.png)

**Klicktest agents (Handy)**

![Klicktest agents (Handy)](media/047-handy-Klicktest-agents-Handy.png)

**Klicktest stats (Handy)**

![Klicktest stats (Handy)](media/048-handy-Klicktest-stats-Handy.png)

**Klicktest settings (Handy)**

![Klicktest settings (Handy)](media/049-handy-Klicktest-settings-Handy.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/050-handy-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/051-handy-Jeder-Knopf-und-Link-anklicken-Dialoge-bearbeiten-und-.webm)

## Ausgabe fehlgeschlagener Prüfungen

<details><summary>Unit-Tests (inkl. UI-Build)</summary>

```text
  ...
# Subtest: Windows-Worker: Zugänge in der Env-Datei, nicht in der Befehlszeile der Aufgabe
ok 859 - Windows-Worker: Zugänge in der Env-Datei, nicht in der Befehlszeile der Aufgabe
  ---
  duration_ms: 1699.000416
  type: 'test'
  ...
# Subtest: templates have unique ids and every non-custom template does something
ok 860 - templates have unique ids and every non-custom template does something
  ---
  duration_ms: 0.410416
  type: 'test'
  ...
# Subtest: agent commands per provider
ok 861 - agent commands per provider
  ---
  duration_ms: 0.339542
  type: 'test'
  ...
# Subtest: check_folder reports existence, emptiness and git state on the host
ok 862 - check_folder reports existence, emptiness and git state on the host
  ---
  duration_ms: 5.470667
  type: 'test'
  ...
# Subtest: folders outside the allowed area are rejected
ok 863 - folders outside the allowed area are rejected
  ---
  duration_ms: 1.243834
  type: 'test'
  ...
1..863
# tests 863
# suites 0
# pass 862
# fail 1
# cancelled 0
# skipped 0
# todo 0
# duration_ms 15696.207375
```

</details>

<details><summary>Oberflächentest</summary>

```text
        at seed (/Volumes/DroneShots/Coding/AIdeation/agent/e2e/full-ui.check.ts:70:7)

    Error Context: ../../../../../var/folders/_5/pb2f9t5159z03xw_4cy18rxr0000gn/T/dev-log-test-full-2026-10-21_17-53/user/full-ui.check.ts-Alle-Seit-a9c73--ohne-seitliches-Überlaufen-desktop/error-context.md

  2) [handy] › e2e/full-ui.check.ts:654:1 › Rollen: Autorin sieht nur, was sie darf ────────────────

    Error: expect(locator).toBeVisible() failed

    Locator: locator('.app-shell')
    Expected: visible
    Timeout: 5000ms
    Error: element(s) not found

    Call log:
      - Expect "toBeVisible" locator('.app-shell') with timeout 5000ms
      - waiting for locator('.app-shell')


      118 |   await page.getByLabel('Passwort').fill(secret);
      119 |   await page.getByRole('button', { name: 'Anmelden' }).click();
    > 120 |   await expect(page.locator('.app-shell')).toBeVisible();
          |                                            ^
      121 | }
      122 |
      123 | async function open(page: Page, section: string): Promise<void> {
        at login (/Volumes/DroneShots/Coding/AIdeation/agent/e2e/full-ui.check.ts:120:44)
        at /Volumes/DroneShots/Coding/AIdeation/agent/e2e/full-ui.check.ts:657:3

    attachment #1: screenshot (image/png) ──────────────────────────────────────────────────────────
    ../../../../../var/folders/_5/pb2f9t5159z03xw_4cy18rxr0000gn/T/dev-log-test-full-2026-10-21_17-53/user/full-ui.check.ts-Rollen-Autorin-sieht-nur-was-sie-darf-handy/test-failed-1.png
    ────────────────────────────────────────────────────────────────────────────────────────────────

    Error Context: ../../../../../var/folders/_5/pb2f9t5159z03xw_4cy18rxr0000gn/T/dev-log-test-full-2026-10-21_17-53/user/full-ui.check.ts-Rollen-Autorin-sieht-nur-was-sie-darf-handy/error-context.md

  2 failed
    [desktop] › e2e/full-ui.check.ts:280:1 › Alle Seiten laden ohne Fehler und ohne seitliches Überlaufen 
    [handy] › e2e/full-ui.check.ts:654:1 › Rollen: Autorin sieht nur, was sie darf ─────────────────
  9 skipped
  13 did not run
  4 passed (2.5m)
```

</details>

