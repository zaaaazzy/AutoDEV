# Testbericht 20.10.2026, 22:04:00

Erstellt mit `npm run test:full`. Gesamtergebnis: ❌ mit Befunden.
Der Oberflächentest läuft auf einer eigenen Testdatenbank (dev_log_full) ohne Worker: Agents, Chat-Antworten und der Projekt-Assistent starten dort nicht.
In AIdeation abgelegt: Projekt `dev-log`, Testlauf `ed29f165-be97-4cc0-9adc-8b485b9b55e9`.

## Übersicht

| Prüfung | Ergebnis | Dauer | Zusammenfassung |
|---|---|---|---|
| Lint | ✅ | 4 s | 500 problems (0 errors, 500 warnings) |
| Formatierung | ❌ | 5 s | nicht formatiert: src/core/env-file.test.ts, src/core/env-file.ts |
| Typprüfung | ✅ | 5 s | Backend und Oberfläche |
| Unit-Tests (inkl. UI-Build) | ✅ | 27 s | 793 bestanden, 0 fehlgeschlagen, 5 Build-Warnungen |
| E2E-Tests | ❌ | 139 s | 44 passed, 4 failed, 2 skipped |
| Oberflächentest | ❌ | 145 s | 4 passed, 2 failed, 9 skipped |

## Befunde des Oberflächentests

| Gerät | Test | Befund |
|---|---|---|
| desktop | Alle Seiten laden ohne Fehler und ohne seitliches Überlaufen | PATCH /api/development/da82bed3-dfd6-4e94-a626-bb4881ef0157: {"message":"Status change backlog → in_progress is not allowed manually; it is set by the worker or a dedicated action."} |
| handy | Rollen: Autorin sieht nur, was sie darf | expect(locator).toBeVisible() failed – Locator: locator('.app-shell') |

## Oberflächentest im Detail

### ❌ Alle Seiten laden ohne Fehler und ohne seitliches Überlaufen · desktop

Status: failed · Dauer 0.0 s

**Befunde:**

- PATCH /api/development/da82bed3-dfd6-4e94-a626-bb4881ef0157: {"message":"Status change backlog → in_progress is not allowed manually; it is set by the worker or a dedicated action."}

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

Status: passed · Dauer 3.9 s

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

Status: skipped · Dauer 0.3 s

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

Status: skipped · Dauer 0.3 s

**Bildschirm am Ende**

![Bildschirm am Ende](media/026-handy-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/027-handy-Dokumentation-Markdown-bearbeiten-einreichen-freigeben.webm)

### ⏭️ Agents: anlegen, Reihenfolge, aktivieren, Detailansicht · handy

Status: skipped · Dauer 0.3 s

**Bildschirm am Ende**

![Bildschirm am Ende](media/028-handy-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/029-handy-Agents-anlegen-Reihenfolge-aktivieren-Detailansicht.webm)

### ✅ Agents: „Was machen die Rollen?“ auf- und zuklappen · handy

Status: passed · Dauer 1.8 s

**Was machen die Rollen**

![Was machen die Rollen](media/030-handy-Was-machen-die-Rollen.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/031-handy-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/032-handy-Agents-Was-machen-die-Rollen-auf-und-zuklappen.webm)

### ✅ Einstellungen: Validierungen, Benutzer anlegen, Projekt löschen gesperrt · handy

Status: passed · Dauer 1.7 s

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

Status: failed · Dauer 5.9 s

**Befunde:**

- expect(locator).toBeVisible() failed – Locator: locator('.app-shell')

**Bildschirm am Ende**

![Bildschirm am Ende](media/038-handy-Bildschirm-am-Ende.png)

### ✅ Jeder Knopf und Link: anklicken, Dialoge bearbeiten und speichern, ohne Fehler · handy

Status: passed · Dauer 126.3 s

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

<details><summary>Formatierung</summary>

```text
> dev-log@1.0.0 format:check
> prettier --check src frontend/src

Checking formatting...
[warn] src/core/env-file.test.ts
[warn] src/core/env-file.ts
[warn] Code style issues found in 2 files. Run Prettier with --write to fix.
```

</details>

<details><summary>E2E-Tests</summary>

```text
  4) [handy] › e2e/app.spec.ts:645:1 › Sprintplanung: Vorschlag mit Begründung und Summen, Aufträge ab- und zuwählen 

    Error: expect(locator).toContainText(expected) failed

    Locator: locator('.sprint-proposal').locator('tbody tr').filter({ hasText: 'Planungs-Auftrag handy 1792526810197' })
    Expected substring: "Priorität hoch"
    Timeout: 5000ms
    Error: element(s) not found

    Call log:
      - Expect "toContainText" locator('.sprint-proposal').locator('tbody tr').filter({ hasText: 'Planungs-Auftrag handy 1792526810197' }) with timeout 5000ms
      - waiting for locator('.sprint-proposal').locator('tbody tr').filter({ hasText: 'Planungs-Auftrag handy 1792526810197' })


      655 |   await expect(card.getByRole('heading', { name: /Vorschlag für Sprint/ })).toBeVisible();
      656 |   const row = card.locator('tbody tr', { hasText: title });
    > 657 |   await expect(row).toContainText('Priorität hoch');
          |                     ^
      658 |   const box = row.getByRole('checkbox');
      659 |   await expect(box).toBeChecked();
      660 |   const totals = card.locator('.proposal-totals');
        at /Volumes/DroneShots/Coding/AIdeation/agent/e2e/app.spec.ts:657:21

    Error Context: test-results/app-Sprintplanung-Vorschla-1bd42-n-Aufträge-ab--und-zuwählen-handy/error-context.md

    attachment #2: trace (application/zip) ─────────────────────────────────────────────────────────
    test-results/app-Sprintplanung-Vorschla-1bd42-n-Aufträge-ab--und-zuwählen-handy/trace.zip
    Usage:

        npx playwright show-trace test-results/app-Sprintplanung-Vorschla-1bd42-n-Aufträge-ab--und-zuwählen-handy/trace.zip

    ────────────────────────────────────────────────────────────────────────────────────────────────

  4 failed
    [desktop] › e2e/app.spec.ts:115:1 › Einstellungen: DoR/DoD, Schalter für App und Push, Zwei-Faktor einrichten 
    [desktop] › e2e/app.spec.ts:645:1 › Sprintplanung: Vorschlag mit Begründung und Summen, Aufträge ab- und zuwählen 
    [handy] › e2e/app.spec.ts:115:1 › Einstellungen: DoR/DoD, Schalter für App und Push, Zwei-Faktor einrichten 
    [handy] › e2e/app.spec.ts:645:1 › Sprintplanung: Vorschlag mit Begründung und Summen, Aufträge ab- und zuwählen 
  2 skipped
  44 passed (2.3m)
```

</details>

<details><summary>Oberflächentest</summary>

```text
        at seed (/Volumes/DroneShots/Coding/AIdeation/agent/e2e/full-ui.check.ts:70:7)

    Error Context: ../../../../../var/folders/_5/pb2f9t5159z03xw_4cy18rxr0000gn/T/dev-log-test-full-2026-10-20_22-04/user/full-ui.check.ts-Alle-Seit-a9c73--ohne-seitliches-Überlaufen-desktop/error-context.md

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
    ../../../../../var/folders/_5/pb2f9t5159z03xw_4cy18rxr0000gn/T/dev-log-test-full-2026-10-20_22-04/user/full-ui.check.ts-Rollen-Autorin-sieht-nur-was-sie-darf-handy/test-failed-1.png
    ────────────────────────────────────────────────────────────────────────────────────────────────

    Error Context: ../../../../../var/folders/_5/pb2f9t5159z03xw_4cy18rxr0000gn/T/dev-log-test-full-2026-10-20_22-04/user/full-ui.check.ts-Rollen-Autorin-sieht-nur-was-sie-darf-handy/error-context.md

  2 failed
    [desktop] › e2e/full-ui.check.ts:280:1 › Alle Seiten laden ohne Fehler und ohne seitliches Überlaufen 
    [handy] › e2e/full-ui.check.ts:654:1 › Rollen: Autorin sieht nur, was sie darf ─────────────────
  9 skipped
  13 did not run
  4 passed (2.4m)
```

</details>

