# Testbericht 19.10.2026, 18:52:10

Erstellt mit `npm run test:full`. Gesamtergebnis: ❌ mit Befunden.
Der Oberflächentest läuft auf einer eigenen Testdatenbank (dev_log_full) ohne Worker: Agents, Chat-Antworten und der Projekt-Assistent starten dort nicht.
In Dev Log abgelegt: Projekt `dev-log`, Testlauf `42114758-1a95-4183-894d-bbd4ae107cee`.

## Übersicht

| Prüfung | Ergebnis | Dauer | Zusammenfassung |
|---|---|---|---|
| Lint | ✅ | 8 s | 201 problems (0 errors, 201 warnings) |
| Formatierung | ✅ | 9 s | alles formatiert |
| Typprüfung | ✅ | 8 s | Backend und Oberfläche |
| Unit-Tests (inkl. UI-Build) | ✅ | 28 s | 251 bestanden, 0 fehlgeschlagen, 3 Build-Warnungen |
| E2E-Tests | ❌ | 74 s | 38 passed, 1 failed, 1 skipped |
| Oberflächentest | ❌ | 300 s | 11 passed, 3 failed |

## Befunde des Oberflächentests

| Gerät | Test | Befund |
|---|---|---|
| desktop | Auftrag: anlegen, Status ändern, erneut versuchen, analysieren, löschen | expect(locator).toBeVisible() failed – Locator: getByText('Auftrag wird erneut versucht.') |
| desktop | Jeder Knopf und Link: anklicken, Dialoge bearbeiten und speichern, ohne Fehler | page.reload: net::ERR_CONNECTION_REFUSED |
| handy | Alle Seiten laden ohne Fehler und ohne seitliches Überlaufen | apiRequestContext.get: connect ECONNREFUSED 127.0.0.1:3196 |

## Oberflächentest im Detail

### ✅ Alle Seiten laden ohne Fehler und ohne seitliches Überlaufen · desktop

Status: passed · Dauer 3.5 s

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

Status: passed · Dauer 62.0 s

**Bildschirm am Ende**

![Bildschirm am Ende](media/013-desktop-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/014-desktop-Tabellen-Sortieren-Filtern-Suchen-und-Zurücksetzen-a.webm)

### ✅ Dashboard: Kennzahlen, Links und Agent-Aktionen · desktop

Status: passed · Dauer 2.8 s

**Agent-Aktionen**

![Agent-Aktionen](media/015-desktop-Agent-Aktionen.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/016-desktop-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/017-desktop-Dashboard-Kennzahlen-Links-und-Agent-Aktionen.webm)

### ❌ Auftrag: anlegen, Status ändern, erneut versuchen, analysieren, löschen · desktop

Status: failed · Dauer 8.7 s

**Befunde:**

- expect(locator).toBeVisible() failed – Locator: getByText('Auftrag wird erneut versucht.')

**Neuer Auftrag geklickt**

![Neuer Auftrag geklickt](media/018-desktop-Neuer-Auftrag-geklickt.png)

**Auftrag Details**

![Auftrag Details](media/019-desktop-Auftrag-Details.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/020-desktop-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/021-desktop-Auftrag-anlegen-Status-ändern-erneut-versuchen-analy.webm)

### ✅ Ideen: anlegen, öffnen, kommentieren, Auftrag erstellen lassen · desktop

Status: passed · Dauer 2.9 s

**Idee mit Kommentar**

![Idee mit Kommentar](media/022-desktop-Idee-mit-Kommentar.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/023-desktop-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/024-desktop-Ideen-anlegen-öffnen-kommentieren-Auftrag-erstellen-.webm)

### ✅ Bugs: anlegen, Status ändern, bearbeiten, löschen · desktop

Status: passed · Dauer 2.9 s

**Bug bearbeitet**

![Bug bearbeitet](media/025-desktop-Bug-bearbeitet.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/026-desktop-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/027-desktop-Bugs-anlegen-Status-ändern-bearbeiten-löschen.webm)

### ✅ Sprints: Datum prüfen, anlegen, Board öffnen, starten · desktop

Status: passed · Dauer 3.1 s

**Sprint-Board**

![Sprint-Board](media/028-desktop-Sprint-Board.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/029-desktop-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/030-desktop-Sprints-Datum-prüfen-anlegen-Board-öffnen-starten.webm)

### ✅ Dokumentation: Markdown, bearbeiten, einreichen, freigeben, neues Handbuch · desktop

Status: passed · Dauer 2.6 s

**Doku Architektur**

![Doku Architektur](media/031-desktop-Doku-Architektur.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/032-desktop-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/033-desktop-Dokumentation-Markdown-bearbeiten-einreichen-freigeb.webm)

### ✅ Agents: anlegen, Reihenfolge, aktivieren, Detailansicht · desktop

Status: passed · Dauer 3.0 s

**Agent-Detail**

![Agent-Detail](media/034-desktop-Agent-Detail.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/035-desktop-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/036-desktop-Agents-anlegen-Reihenfolge-aktivieren-Detailansicht.webm)

### ✅ Einstellungen: Validierungen, Benutzer anlegen, Projekt löschen gesperrt · desktop

Status: passed · Dauer 3.4 s

**Einstellungen**

![Einstellungen](media/037-desktop-Einstellungen.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/038-desktop-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/039-desktop-Einstellungen-Validierungen-Benutzer-anlegen-Projekt.webm)

### ✅ Projektwechsel trennt die Daten · desktop

Status: passed · Dauer 2.8 s

**Bildschirm am Ende**

![Bildschirm am Ende](media/040-desktop-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/041-desktop-Projektwechsel-trennt-die-Daten.webm)

### ✅ Rollen: Autorin sieht nur, was sie darf · desktop

Status: passed · Dauer 2.2 s

**Ansicht der Autorin**

![Ansicht der Autorin](media/042-desktop-Ansicht-der-Autorin.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/043-desktop-Bildschirm-am-Ende.png)

### ❌ Jeder Knopf und Link: anklicken, Dialoge bearbeiten und speichern, ohne Fehler · desktop

Status: failed · Dauer 193.2 s

**Befunde:**

- page.reload: net::ERR_CONNECTION_REFUSED

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

**Bildschirm am Ende**

![Bildschirm am Ende](media/051-desktop-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/052-desktop-Jeder-Knopf-und-Link-anklicken-Dialoge-bearbeiten-un.webm)

### ❌ Alle Seiten laden ohne Fehler und ohne seitliches Überlaufen · handy

Status: failed · Dauer 0.0 s

**Befunde:**

- apiRequestContext.get: connect ECONNREFUSED 127.0.0.1:3196

### ⏭️ Tabellen: Sortieren, Filtern, Suchen und Zurücksetzen auf allen Seiten · handy

Status: skipped · Dauer 0.0 s

### ⏭️ Dashboard: Kennzahlen, Links und Agent-Aktionen · handy

Status: skipped · Dauer 0.0 s

### ⏭️ Auftrag: anlegen, Status ändern, erneut versuchen, analysieren, löschen · handy

Status: skipped · Dauer 0.0 s

### ⏭️ Ideen: anlegen, öffnen, kommentieren, Auftrag erstellen lassen · handy

Status: skipped · Dauer 0.0 s

### ⏭️ Bugs: anlegen, Status ändern, bearbeiten, löschen · handy

Status: skipped · Dauer 0.0 s

### ⏭️ Sprints: Datum prüfen, anlegen, Board öffnen, starten · handy

Status: skipped · Dauer 0.0 s

### ⏭️ Dokumentation: Markdown, bearbeiten, einreichen, freigeben, neues Handbuch · handy

Status: skipped · Dauer 0.0 s

### ⏭️ Agents: anlegen, Reihenfolge, aktivieren, Detailansicht · handy

Status: skipped · Dauer 0.0 s

### ⏭️ Einstellungen: Validierungen, Benutzer anlegen, Projekt löschen gesperrt · handy

Status: skipped · Dauer 0.0 s

### ⏭️ Projektwechsel trennt die Daten · handy

Status: skipped · Dauer 0.0 s

### ⏭️ Rollen: Autorin sieht nur, was sie darf · handy

Status: skipped · Dauer 0.0 s

### ⏭️ Jeder Knopf und Link: anklicken, Dialoge bearbeiten und speichern, ohne Fehler · handy

Status: skipped · Dauer 0.0 s

## Ausgabe fehlgeschlagener Prüfungen

<details><summary>E2E-Tests</summary>

```text
  ✓  40 [handy] › e2e/app.spec.ts:560:1 › App-Grundlagen: Manifest, Symbole und Service Worker (1.2s)


  1) [handy] › e2e/app.spec.ts:336:1 › Agent-Aktionen: alle Aktionen nach Agent gruppiert im Assistenten, Details beim Hover, eigene Aktion anlegen 

    Error: expect(locator).toContainText(expected) failed

    Locator: getByRole('dialog', { name: 'Agent-Aktionen' }).locator('.agent-task-detail')
    Expected substring: "docker compose up -d"
    Timeout: 5000ms
    Error: element(s) not found

    Call log:
      - Expect "toContainText" getByRole('dialog', { name: 'Agent-Aktionen' }).locator('.agent-task-detail') with timeout 5000ms
      - waiting for getByRole('dialog', { name: 'Agent-Aktionen' }).locator('.agent-task-detail')


      375 |   await expect(groups).toHaveText(['Tester']);
      376 |   await search.press('ArrowDown');
    > 377 |   await expect(detail).toContainText('docker compose up -d');
          |                        ^
      378 |   await search.fill(title);
      379 |   await expect(menu.getByText('Keine Aktion gefunden.')).toBeVisible();
      380 |   await menu.getByRole('button', { name: `+ Neue Aktion „${title}“` }).click();
        at /Volumes/External/DevLog-agents/e2e/app.spec.ts:377:24

    Error Context: test-results/app-Agent-Aktionen-alle-Ak-4b50b-Hover-eigene-Aktion-anlegen-handy/error-context.md

    attachment #2: trace (application/zip) ─────────────────────────────────────────────────────────
    test-results/app-Agent-Aktionen-alle-Ak-4b50b-Hover-eigene-Aktion-anlegen-handy/trace.zip
    Usage:

        npx playwright show-trace test-results/app-Agent-Aktionen-alle-Ak-4b50b-Hover-eigene-Aktion-anlegen-handy/trace.zip

    ────────────────────────────────────────────────────────────────────────────────────────────────

  1 failed
    [handy] › e2e/app.spec.ts:336:1 › Agent-Aktionen: alle Aktionen nach Agent gruppiert im Assistenten, Details beim Hover, eigene Aktion anlegen 
  1 skipped
  38 passed (1.2m)
```

</details>

<details><summary>Oberflächentest</summary>

```text

    attachment #8: screenshot (image/png) ──────────────────────────────────────────────────────────
    ../../../var/folders/_5/pb2f9t5159z03xw_4cy18rxr0000gn/T/dev-log-test-full-2026-10-19_18-52/user/full-ui.check.ts-Jeder-Kno-53c3f-n-und-speichern-ohne-Fehler-desktop/test-failed-1.png
    ────────────────────────────────────────────────────────────────────────────────────────────────

    attachment #9: video (video/webm) ──────────────────────────────────────────────────────────────
    ../../../var/folders/_5/pb2f9t5159z03xw_4cy18rxr0000gn/T/dev-log-test-full-2026-10-19_18-52/user/full-ui.check.ts-Jeder-Kno-53c3f-n-und-speichern-ohne-Fehler-desktop/video.webm
    ────────────────────────────────────────────────────────────────────────────────────────────────

    Error Context: ../../../var/folders/_5/pb2f9t5159z03xw_4cy18rxr0000gn/T/dev-log-test-full-2026-10-19_18-52/user/full-ui.check.ts-Jeder-Kno-53c3f-n-und-speichern-ohne-Fehler-desktop/error-context.md

  3) [handy] › e2e/full-ui.check.ts:278:1 › Alle Seiten laden ohne Fehler und ohne seitliches Überlaufen 

    Error: apiRequestContext.get: connect ECONNREFUSED 127.0.0.1:3196
    Call log:
      - → GET http://127.0.0.1:3196/api/projects
        - user-agent: Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.8078.4 Mobile Safari/537.36
        - accept: */*
        - accept-encoding: gzip,deflate,br
        - Authorization: Basic ZTJlLXRlc3RlcjphYzZhZjU5YjZkOGJhZGNkN2ZhMzZlZGViYjQ4NDVmYQ==


      30 | /** Beispieldaten: zwei Projekte, Ideen, Aufträge in allen Status, Bugs aller Schweregrade, Sprints, Doku, Autorin. */
      31 | async function seed(request: APIRequestContext): Promise<void> {
    > 32 |   const projects = await (await request.get('/api/projects', { headers: auth })).json();
         |                                         ^
      33 |   if (projects.projects.some((project: { slug: string }) => project.slug === 'alpha')) return;
      34 |   const call = async (method: 'post' | 'patch', url: string, data: object) => {
      35 |     const response = await request[method](url, { headers: auth, data });
        at seed (/Volumes/External/DevLog-agents/e2e/full-ui.check.ts:32:41)
        at /Volumes/External/DevLog-agents/e2e/full-ui.check.ts:276:39

    Error Context: ../../../var/folders/_5/pb2f9t5159z03xw_4cy18rxr0000gn/T/dev-log-test-full-2026-10-19_18-52/user/full-ui.check.ts-Alle-Seit-a9c73--ohne-seitliches-Überlaufen-handy/error-context.md

  3 failed
    [desktop] › e2e/full-ui.check.ts:352:1 › Auftrag: anlegen, Status ändern, erneut versuchen, analysieren, löschen 
    [desktop] › e2e/full-ui.check.ts:698:1 › Jeder Knopf und Link: anklicken, Dialoge bearbeiten und speichern, ohne Fehler 
    [handy] › e2e/full-ui.check.ts:278:1 › Alle Seiten laden ohne Fehler und ohne seitliches Überlaufen 
  12 did not run
  11 passed (5.0m)
```

</details>

