# Testbericht 18.10.2026, 21:37:29

Erstellt mit `npm run test:full`. Gesamtergebnis: ❌ mit Befunden.
Der Oberflächentest läuft auf einer eigenen Testdatenbank (dev_log_full) ohne Worker: Agents, Chat-Antworten und der Projekt-Assistent starten dort nicht.
In Dev Log abgelegt: Projekt `dev-log`, Testlauf `57090706-0ddd-4d18-afdb-ad19033c636a`.

## Übersicht

| Prüfung | Ergebnis | Dauer | Zusammenfassung |
|---|---|---|---|
| Oberflächentest | ❌ | 683 s | 6 passed, 11 failed, 9 skipped |

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
| desktop | Jeder Knopf und Link: anklicken, Dialoge bearbeiten und speichern, ohne Fehler | ideation · Knopf „Titel filtern“: Menü bleibt nach Escape offen |
| desktop | Jeder Knopf und Link: anklicken, Dialoge bearbeiten und speichern, ohne Fehler | ideation · Knopf „Status filtern“: Menü bleibt nach Escape offen |
| desktop | Jeder Knopf und Link: anklicken, Dialoge bearbeiten und speichern, ohne Fehler | ideation · Knopf „Kategorie filtern“: Menü bleibt nach Escape offen |
| desktop | Jeder Knopf und Link: anklicken, Dialoge bearbeiten und speichern, ohne Fehler | ideation · Knopf „Priorität filtern“: Menü bleibt nach Escape offen |
| desktop | Jeder Knopf und Link: anklicken, Dialoge bearbeiten und speichern, ohne Fehler | ideation · Knopf „Aufwand filtern“: Menü bleibt nach Escape offen |
| desktop | Jeder Knopf und Link: anklicken, Dialoge bearbeiten und speichern, ohne Fehler | ideation · Knopf „Erstellt filtern“: Menü bleibt nach Escape offen |
| desktop | Jeder Knopf und Link: anklicken, Dialoge bearbeiten und speichern, ohne Fehler | ideation · Knopf „Titel filtern“: Menü bleibt nach Escape offen |
| desktop | Jeder Knopf und Link: anklicken, Dialoge bearbeiten und speichern, ohne Fehler | ideation · Knopf „Status filtern“: Menü bleibt nach Escape offen |
| desktop | Jeder Knopf und Link: anklicken, Dialoge bearbeiten und speichern, ohne Fehler | ideation · Knopf „Kategorie filtern“: Menü bleibt nach Escape offen |
| desktop | Jeder Knopf und Link: anklicken, Dialoge bearbeiten und speichern, ohne Fehler | ideation · Knopf „Erstellt filtern“: Menü bleibt nach Escape offen |
| desktop | Jeder Knopf und Link: anklicken, Dialoge bearbeiten und speichern, ohne Fehler | development · Knopf „Titel filtern“: Menü bleibt nach Escape offen |
| desktop | Jeder Knopf und Link: anklicken, Dialoge bearbeiten und speichern, ohne Fehler | development · Knopf „Status filtern“: Menü bleibt nach Escape offen |
| desktop | Jeder Knopf und Link: anklicken, Dialoge bearbeiten und speichern, ohne Fehler | development · Knopf „Priorität filtern“: Menü bleibt nach Escape offen |
| desktop | Jeder Knopf und Link: anklicken, Dialoge bearbeiten und speichern, ohne Fehler | development · Knopf „Kategorie filtern“: Menü bleibt nach Escape offen |
| desktop | Jeder Knopf und Link: anklicken, Dialoge bearbeiten und speichern, ohne Fehler | development · Knopf „Sprint filtern“: Menü bleibt nach Escape offen |
| desktop | Jeder Knopf und Link: anklicken, Dialoge bearbeiten und speichern, ohne Fehler | development · Knopf „Aufwand filtern“: Menü bleibt nach Escape offen |
| desktop | Jeder Knopf und Link: anklicken, Dialoge bearbeiten und speichern, ohne Fehler | sprints · Knopf „Sprint filtern“: Menü bleibt nach Escape offen |
| desktop | Jeder Knopf und Link: anklicken, Dialoge bearbeiten und speichern, ohne Fehler | sprints · Knopf „Status filtern“: Menü bleibt nach Escape offen |
| desktop | Jeder Knopf und Link: anklicken, Dialoge bearbeiten und speichern, ohne Fehler | sprints · Knopf „Kategorie filtern“: Menü bleibt nach Escape offen |
| desktop | Jeder Knopf und Link: anklicken, Dialoge bearbeiten und speichern, ohne Fehler | bugs · Knopf „Titel filtern“: Menü bleibt nach Escape offen |
| desktop | Dashboard: Kennzahlen, Links und Agent-Aufgaben | TimeoutError: locator.click: Timeout 15000ms exceeded. – waiting for getByRole('button', { name: 'Aufgaben', exact: true }).first() |
| desktop | Auftrag: anlegen, Status ändern, erneut versuchen, analysieren, löschen | TimeoutError: locator.textContent: Timeout 15000ms exceeded. – waiting for locator('.attention-card').filter({ hasText: 'Warenkorb blocked' }).first().locator('.attention-title') |
| desktop | Ideen: anlegen, öffnen, kommentieren, Auftrag erstellen lassen | TimeoutError: locator.click: Timeout 15000ms exceeded. – waiting for getByRole('button', { name: 'Kommentieren', exact: true }).first() |
| desktop | Sprints: Datum prüfen, anlegen, Board öffnen, starten | „Sprint starten“ setzt das Startdatum |
| desktop | Agents: anlegen, Reihenfolge, aktivieren, Detailansicht | Detail bleibt nach ↑ offen |
| desktop | Agents: anlegen, Reihenfolge, aktivieren, Detailansicht | Kein doppeltes „Sprint Sprint“ |
| desktop | Agents: anlegen, Reihenfolge, aktivieren, Detailansicht | Zurück-Button führt zur Agent-Liste |
| desktop | Projektwechsel trennt die Daten | Leertext ohne Filter spricht nicht von Filtern |
| desktop | Rollen: Autorin sieht nur, was sie darf | Ohne Chat-Rolle kein „Verlauf leeren“ |
| desktop | Rollen: Autorin sieht nur, was sie darf | Ohne Agent-Verwaltung kein „Standard-Workflow anlegen“ |
| handy | Jeder Knopf und Link: anklicken, Dialoge bearbeiten und speichern, ohne Fehler | ideation · Knopf „Titel filtern“: Menü bleibt nach Escape offen |
| handy | Jeder Knopf und Link: anklicken, Dialoge bearbeiten und speichern, ohne Fehler | ideation · Knopf „Status filtern“: Menü bleibt nach Escape offen |
| handy | Jeder Knopf und Link: anklicken, Dialoge bearbeiten und speichern, ohne Fehler | ideation · Knopf „Kategorie filtern“: Menü bleibt nach Escape offen |
| handy | Jeder Knopf und Link: anklicken, Dialoge bearbeiten und speichern, ohne Fehler | ideation · Knopf „Priorität filtern“: Menü bleibt nach Escape offen |
| handy | Jeder Knopf und Link: anklicken, Dialoge bearbeiten und speichern, ohne Fehler | ideation · Knopf „Aufwand filtern“: Menü bleibt nach Escape offen |
| handy | Jeder Knopf und Link: anklicken, Dialoge bearbeiten und speichern, ohne Fehler | ideation · Knopf „Erstellt filtern“: Menü bleibt nach Escape offen |
| handy | Jeder Knopf und Link: anklicken, Dialoge bearbeiten und speichern, ohne Fehler | ideation · Knopf „Titel filtern“: Menü bleibt nach Escape offen |
| handy | Jeder Knopf und Link: anklicken, Dialoge bearbeiten und speichern, ohne Fehler | ideation · Knopf „Status filtern“: Menü bleibt nach Escape offen |
| handy | Jeder Knopf und Link: anklicken, Dialoge bearbeiten und speichern, ohne Fehler | ideation · Knopf „Kategorie filtern“: Menü bleibt nach Escape offen |
| handy | Jeder Knopf und Link: anklicken, Dialoge bearbeiten und speichern, ohne Fehler | ideation · Knopf „Erstellt filtern“: Menü bleibt nach Escape offen |
| handy | Jeder Knopf und Link: anklicken, Dialoge bearbeiten und speichern, ohne Fehler | development · Knopf „Titel filtern“: Menü bleibt nach Escape offen |
| handy | Jeder Knopf und Link: anklicken, Dialoge bearbeiten und speichern, ohne Fehler | development · Knopf „Status filtern“: Menü bleibt nach Escape offen |
| handy | Jeder Knopf und Link: anklicken, Dialoge bearbeiten und speichern, ohne Fehler | development · Knopf „Priorität filtern“: Menü bleibt nach Escape offen |
| handy | Jeder Knopf und Link: anklicken, Dialoge bearbeiten und speichern, ohne Fehler | development · Knopf „Kategorie filtern“: Menü bleibt nach Escape offen |
| handy | Jeder Knopf und Link: anklicken, Dialoge bearbeiten und speichern, ohne Fehler | development · Knopf „Sprint filtern“: Menü bleibt nach Escape offen |
| handy | Jeder Knopf und Link: anklicken, Dialoge bearbeiten und speichern, ohne Fehler | development · Knopf „Aufwand filtern“: Menü bleibt nach Escape offen |
| handy | Jeder Knopf und Link: anklicken, Dialoge bearbeiten und speichern, ohne Fehler | sprints · Knopf „Sprint filtern“: Menü bleibt nach Escape offen |
| handy | Jeder Knopf und Link: anklicken, Dialoge bearbeiten und speichern, ohne Fehler | sprints · Knopf „Status filtern“: Menü bleibt nach Escape offen |
| handy | Jeder Knopf und Link: anklicken, Dialoge bearbeiten und speichern, ohne Fehler | sprints · Knopf „Kategorie filtern“: Menü bleibt nach Escape offen |
| handy | Jeder Knopf und Link: anklicken, Dialoge bearbeiten und speichern, ohne Fehler | bugs · Knopf „Titel filtern“: Menü bleibt nach Escape offen |
| handy | Rollen: Autorin sieht nur, was sie darf | Ohne Chat-Rolle kein „Verlauf leeren“ |
| handy | Rollen: Autorin sieht nur, was sie darf | Ohne Agent-Verwaltung kein „Standard-Workflow anlegen“ |

## Oberflächentest im Detail

### ✅ Alle Seiten laden ohne Fehler und ohne seitliches Überlaufen · desktop

Status: passed · Dauer 5.9 s

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

Status: failed · Dauer 69.7 s

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

### ❌ Jeder Knopf und Link: anklicken, Dialoge bearbeiten und speichern, ohne Fehler · desktop

Status: failed · Dauer 225.0 s

**Befunde:**

- ideation · Knopf „Titel filtern“: Menü bleibt nach Escape offen
- ideation · Knopf „Status filtern“: Menü bleibt nach Escape offen
- ideation · Knopf „Kategorie filtern“: Menü bleibt nach Escape offen
- ideation · Knopf „Priorität filtern“: Menü bleibt nach Escape offen
- ideation · Knopf „Aufwand filtern“: Menü bleibt nach Escape offen
- ideation · Knopf „Erstellt filtern“: Menü bleibt nach Escape offen
- ideation · Knopf „Titel filtern“: Menü bleibt nach Escape offen
- ideation · Knopf „Status filtern“: Menü bleibt nach Escape offen
- ideation · Knopf „Kategorie filtern“: Menü bleibt nach Escape offen
- ideation · Knopf „Erstellt filtern“: Menü bleibt nach Escape offen
- development · Knopf „Titel filtern“: Menü bleibt nach Escape offen
- development · Knopf „Status filtern“: Menü bleibt nach Escape offen
- development · Knopf „Priorität filtern“: Menü bleibt nach Escape offen
- development · Knopf „Kategorie filtern“: Menü bleibt nach Escape offen
- development · Knopf „Sprint filtern“: Menü bleibt nach Escape offen
- development · Knopf „Aufwand filtern“: Menü bleibt nach Escape offen
- sprints · Knopf „Sprint filtern“: Menü bleibt nach Escape offen
- sprints · Knopf „Status filtern“: Menü bleibt nach Escape offen
- sprints · Knopf „Kategorie filtern“: Menü bleibt nach Escape offen
- bugs · Knopf „Titel filtern“: Menü bleibt nach Escape offen

**Klicktest dashboard**

![Klicktest dashboard](media/015-desktop-Klicktest-dashboard.png)

**Klicktest docs**

![Klicktest docs](media/016-desktop-Klicktest-docs.png)

**Klicktest ideation**

![Klicktest ideation](media/017-desktop-Klicktest-ideation.png)

**Klicktest development**

![Klicktest development](media/018-desktop-Klicktest-development.png)

**Klicktest sprints**

![Klicktest sprints](media/019-desktop-Klicktest-sprints.png)

**Klicktest bugs**

![Klicktest bugs](media/020-desktop-Klicktest-bugs.png)

**Klicktest runs**

![Klicktest runs](media/021-desktop-Klicktest-runs.png)

**Klicktest agents**

![Klicktest agents](media/022-desktop-Klicktest-agents.png)

**Klicktest stats**

![Klicktest stats](media/023-desktop-Klicktest-stats.png)

**Klicktest settings**

![Klicktest settings](media/024-desktop-Klicktest-settings.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/025-desktop-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/026-desktop-Jeder-Knopf-und-Link-anklicken-Dialoge-bearbeiten-un.webm)

### ❌ Dashboard: Kennzahlen, Links und Agent-Aufgaben · desktop

Status: failed · Dauer 18.6 s

**Befunde:**

- TimeoutError: locator.click: Timeout 15000ms exceeded. – waiting for getByRole('button', { name: 'Aufgaben', exact: true }).first()

**Bildschirm am Ende**

![Bildschirm am Ende](media/027-desktop-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/028-desktop-Dashboard-Kennzahlen-Links-und-Agent-Aufgaben.webm)

### ❌ Auftrag: anlegen, Status ändern, erneut versuchen, analysieren, löschen · desktop

Status: failed · Dauer 18.5 s

**Befunde:**

- TimeoutError: locator.textContent: Timeout 15000ms exceeded. – waiting for locator('.attention-card').filter({ hasText: 'Warenkorb blocked' }).first().locator('.attention-title')

**Neuer Auftrag geklickt**

![Neuer Auftrag geklickt](media/029-desktop-Neuer-Auftrag-geklickt.png)

**Auftrag Details**

![Auftrag Details](media/030-desktop-Auftrag-Details.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/031-desktop-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/032-desktop-Auftrag-anlegen-Status-ändern-erneut-versuchen-analy.webm)

### ❌ Ideen: anlegen, öffnen, kommentieren, Auftrag erstellen lassen · desktop

Status: failed · Dauer 17.4 s

**Befunde:**

- TimeoutError: locator.click: Timeout 15000ms exceeded. – waiting for getByRole('button', { name: 'Kommentieren', exact: true }).first()

**Bildschirm am Ende**

![Bildschirm am Ende](media/033-desktop-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/034-desktop-Ideen-anlegen-öffnen-kommentieren-Auftrag-erstellen-.webm)

### ✅ Bugs: anlegen, Status ändern, bearbeiten, löschen · desktop

Status: passed · Dauer 3.0 s

**Bug bearbeitet**

![Bug bearbeitet](media/035-desktop-Bug-bearbeitet.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/036-desktop-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/037-desktop-Bugs-anlegen-Status-ändern-bearbeiten-löschen.webm)

### ❌ Sprints: Datum prüfen, anlegen, Board öffnen, starten · desktop

Status: failed · Dauer 8.1 s

**Befunde:**

- „Sprint starten“ setzt das Startdatum

**Sprint-Board**

![Sprint-Board](media/038-desktop-Sprint-Board.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/039-desktop-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/040-desktop-Sprints-Datum-prüfen-anlegen-Board-öffnen-starten.webm)

### ✅ Dokumentation: Markdown, bearbeiten, einreichen, freigeben, neues Handbuch · desktop

Status: passed · Dauer 3.0 s

**Doku Architektur**

![Doku Architektur](media/041-desktop-Doku-Architektur.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/042-desktop-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/043-desktop-Dokumentation-Markdown-bearbeiten-einreichen-freigeb.webm)

### ❌ Agents: anlegen, Reihenfolge, aktivieren, Detailansicht · desktop

Status: failed · Dauer 18.1 s

**Befunde:**

- Detail bleibt nach ↑ offen
- Kein doppeltes „Sprint Sprint“
- Zurück-Button führt zur Agent-Liste

**Agent-Detail**

![Agent-Detail](media/044-desktop-Agent-Detail.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/045-desktop-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/046-desktop-Agents-anlegen-Reihenfolge-aktivieren-Detailansicht.webm)

### ✅ Einstellungen: Validierungen, Benutzer anlegen, Projekt löschen gesperrt · desktop

Status: passed · Dauer 3.9 s

**Einstellungen**

![Einstellungen](media/047-desktop-Einstellungen.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/048-desktop-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/049-desktop-Einstellungen-Validierungen-Benutzer-anlegen-Projekt.webm)

### ❌ Projektwechsel trennt die Daten · desktop

Status: failed · Dauer 7.7 s

**Befunde:**

- Leertext ohne Filter spricht nicht von Filtern

**Bildschirm am Ende**

![Bildschirm am Ende](media/050-desktop-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/051-desktop-Projektwechsel-trennt-die-Daten.webm)

### ❌ Rollen: Autorin sieht nur, was sie darf · desktop

Status: failed · Dauer 11.8 s

**Befunde:**

- Ohne Chat-Rolle kein „Verlauf leeren“
- Ohne Agent-Verwaltung kein „Standard-Workflow anlegen“

**Ansicht der Autorin**

![Ansicht der Autorin](media/052-desktop-Ansicht-der-Autorin.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/053-desktop-Bildschirm-am-Ende.png)

### ✅ Alle Seiten laden ohne Fehler und ohne seitliches Überlaufen · handy

Status: passed · Dauer 9.5 s

**dashboard (Handy)**

![dashboard (Handy)](media/054-handy-dashboard-Handy.png)

**docs (Handy)**

![docs (Handy)](media/055-handy-docs-Handy.png)

**ideation (Handy)**

![ideation (Handy)](media/056-handy-ideation-Handy.png)

**development (Handy)**

![development (Handy)](media/057-handy-development-Handy.png)

**sprints (Handy)**

![sprints (Handy)](media/058-handy-sprints-Handy.png)

**bugs (Handy)**

![bugs (Handy)](media/059-handy-bugs-Handy.png)

**runs (Handy)**

![runs (Handy)](media/060-handy-runs-Handy.png)

**agents (Handy)**

![agents (Handy)](media/061-handy-agents-Handy.png)

**stats (Handy)**

![stats (Handy)](media/062-handy-stats-Handy.png)

**settings (Handy)**

![settings (Handy)](media/063-handy-settings-Handy.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/064-handy-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/065-handy-Alle-Seiten-laden-ohne-Fehler-und-ohne-seitliches-Über.webm)

### ⏭️ Tabellen: Sortieren, Filtern, Suchen und Zurücksetzen auf allen Seiten · handy

Status: skipped · Dauer 0.4 s

**Bildschirm am Ende**

![Bildschirm am Ende](media/066-handy-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/067-handy-Tabellen-Sortieren-Filtern-Suchen-und-Zurücksetzen-auf.webm)

### ❌ Jeder Knopf und Link: anklicken, Dialoge bearbeiten und speichern, ohne Fehler · handy

Status: failed · Dauer 230.6 s

**Befunde:**

- ideation · Knopf „Titel filtern“: Menü bleibt nach Escape offen
- ideation · Knopf „Status filtern“: Menü bleibt nach Escape offen
- ideation · Knopf „Kategorie filtern“: Menü bleibt nach Escape offen
- ideation · Knopf „Priorität filtern“: Menü bleibt nach Escape offen
- ideation · Knopf „Aufwand filtern“: Menü bleibt nach Escape offen
- ideation · Knopf „Erstellt filtern“: Menü bleibt nach Escape offen
- ideation · Knopf „Titel filtern“: Menü bleibt nach Escape offen
- ideation · Knopf „Status filtern“: Menü bleibt nach Escape offen
- ideation · Knopf „Kategorie filtern“: Menü bleibt nach Escape offen
- ideation · Knopf „Erstellt filtern“: Menü bleibt nach Escape offen
- development · Knopf „Titel filtern“: Menü bleibt nach Escape offen
- development · Knopf „Status filtern“: Menü bleibt nach Escape offen
- development · Knopf „Priorität filtern“: Menü bleibt nach Escape offen
- development · Knopf „Kategorie filtern“: Menü bleibt nach Escape offen
- development · Knopf „Sprint filtern“: Menü bleibt nach Escape offen
- development · Knopf „Aufwand filtern“: Menü bleibt nach Escape offen
- sprints · Knopf „Sprint filtern“: Menü bleibt nach Escape offen
- sprints · Knopf „Status filtern“: Menü bleibt nach Escape offen
- sprints · Knopf „Kategorie filtern“: Menü bleibt nach Escape offen
- bugs · Knopf „Titel filtern“: Menü bleibt nach Escape offen

**Klicktest dashboard (Handy)**

![Klicktest dashboard (Handy)](media/068-handy-Klicktest-dashboard-Handy.png)

**Klicktest docs (Handy)**

![Klicktest docs (Handy)](media/069-handy-Klicktest-docs-Handy.png)

**Klicktest ideation (Handy)**

![Klicktest ideation (Handy)](media/070-handy-Klicktest-ideation-Handy.png)

**Klicktest development (Handy)**

![Klicktest development (Handy)](media/071-handy-Klicktest-development-Handy.png)

**Klicktest sprints (Handy)**

![Klicktest sprints (Handy)](media/072-handy-Klicktest-sprints-Handy.png)

**Klicktest bugs (Handy)**

![Klicktest bugs (Handy)](media/073-handy-Klicktest-bugs-Handy.png)

**Klicktest runs (Handy)**

![Klicktest runs (Handy)](media/074-handy-Klicktest-runs-Handy.png)

**Klicktest agents (Handy)**

![Klicktest agents (Handy)](media/075-handy-Klicktest-agents-Handy.png)

**Klicktest stats (Handy)**

![Klicktest stats (Handy)](media/076-handy-Klicktest-stats-Handy.png)

**Klicktest settings (Handy)**

![Klicktest settings (Handy)](media/077-handy-Klicktest-settings-Handy.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/078-handy-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/079-handy-Jeder-Knopf-und-Link-anklicken-Dialoge-bearbeiten-und-.webm)

### ⏭️ Dashboard: Kennzahlen, Links und Agent-Aufgaben · handy

Status: skipped · Dauer 0.5 s

**Bildschirm am Ende**

![Bildschirm am Ende](media/080-handy-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/081-handy-Dashboard-Kennzahlen-Links-und-Agent-Aufgaben.webm)

### ⏭️ Auftrag: anlegen, Status ändern, erneut versuchen, analysieren, löschen · handy

Status: skipped · Dauer 0.4 s

**Bildschirm am Ende**

![Bildschirm am Ende](media/082-handy-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/083-handy-Auftrag-anlegen-Status-ändern-erneut-versuchen-analysi.webm)

### ⏭️ Ideen: anlegen, öffnen, kommentieren, Auftrag erstellen lassen · handy

Status: skipped · Dauer 0.6 s

**Bildschirm am Ende**

![Bildschirm am Ende](media/084-handy-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/085-handy-Ideen-anlegen-öffnen-kommentieren-Auftrag-erstellen-la.webm)

### ⏭️ Bugs: anlegen, Status ändern, bearbeiten, löschen · handy

Status: skipped · Dauer 0.4 s

**Bildschirm am Ende**

![Bildschirm am Ende](media/086-handy-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/087-handy-Bugs-anlegen-Status-ändern-bearbeiten-löschen.webm)

### ⏭️ Sprints: Datum prüfen, anlegen, Board öffnen, starten · handy

Status: skipped · Dauer 0.4 s

**Bildschirm am Ende**

![Bildschirm am Ende](media/088-handy-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/089-handy-Sprints-Datum-prüfen-anlegen-Board-öffnen-starten.webm)

### ⏭️ Dokumentation: Markdown, bearbeiten, einreichen, freigeben, neues Handbuch · handy

Status: skipped · Dauer 0.4 s

**Bildschirm am Ende**

![Bildschirm am Ende](media/090-handy-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/091-handy-Dokumentation-Markdown-bearbeiten-einreichen-freigeben.webm)

### ⏭️ Agents: anlegen, Reihenfolge, aktivieren, Detailansicht · handy

Status: skipped · Dauer 0.5 s

**Bildschirm am Ende**

![Bildschirm am Ende](media/092-handy-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/093-handy-Agents-anlegen-Reihenfolge-aktivieren-Detailansicht.webm)

### ✅ Einstellungen: Validierungen, Benutzer anlegen, Projekt löschen gesperrt · handy

Status: passed · Dauer 2.4 s

**Projekt löschen (Handy)**

![Projekt löschen (Handy)](media/094-handy-Projekt-löschen-Handy.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/095-handy-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/096-handy-Einstellungen-Validierungen-Benutzer-anlegen-Projekt-l.webm)

### ⏭️ Projektwechsel trennt die Daten · handy

Status: skipped · Dauer 0.3 s

**Bildschirm am Ende**

![Bildschirm am Ende](media/097-handy-Bildschirm-am-Ende.png)

🎬 [Video ansehen](media/098-handy-Projektwechsel-trennt-die-Daten.webm)

### ❌ Rollen: Autorin sieht nur, was sie darf · handy

Status: failed · Dauer 12.2 s

**Befunde:**

- Ohne Chat-Rolle kein „Verlauf leeren“
- Ohne Agent-Verwaltung kein „Standard-Workflow anlegen“

**Ansicht der Autorin**

![Ansicht der Autorin](media/099-handy-Ansicht-der-Autorin.png)

**Bildschirm am Ende**

![Bildschirm am Ende](media/100-handy-Bildschirm-am-Ende.png)

## Ausgabe fehlgeschlagener Prüfungen

<details><summary>Oberflächentest</summary>

```text
    Call log:
      - Ohne Agent-Verwaltung kein „Standard-Workflow anlegen“ getByRole('button', { name: /Standard-Workflow anlegen/ }).first() with timeout 5000ms
      - waiting for getByRole('button', { name: /Standard-Workflow anlegen/ }).first()
        14 × locator resolved to 1 element
           - unexpected value "1"


      800 |   await expect
      801 |     .soft(button(page, /Standard-Workflow anlegen/), 'Ohne Agent-Verwaltung kein „Standard-Workflow anlegen“')
    > 802 |     .toHaveCount(0);
          |      ^
      803 |   expect((await page.request.post('/api/users', { data: {} })).status()).toBe(403);
      804 |   await snap(page, info, 'Ansicht der Autorin');
      805 |   await context.close();
        at /Volumes/External/DevLog-agents/e2e/full-ui.check.ts:802:6

    attachment #1: Ansicht der Autorin (image/png) ─────────────────────────────────────────────────
    ../../../var/folders/_5/pb2f9t5159z03xw_4cy18rxr0000gn/T/dev-log-test-full-2026-10-18_21-37/user/full-ui.check.ts-Rollen-Autorin-sieht-nur-was-sie-darf-handy/attachments/Ansicht-der-Autorin-fe71940d09aa3d71333cd957df7c50344ed0d0aa.png
    ────────────────────────────────────────────────────────────────────────────────────────────────

    attachment #2: screenshot (image/png) ──────────────────────────────────────────────────────────
    ../../../var/folders/_5/pb2f9t5159z03xw_4cy18rxr0000gn/T/dev-log-test-full-2026-10-18_21-37/user/full-ui.check.ts-Rollen-Autorin-sieht-nur-was-sie-darf-handy/test-failed-1.png
    ────────────────────────────────────────────────────────────────────────────────────────────────

    Error Context: ../../../var/folders/_5/pb2f9t5159z03xw_4cy18rxr0000gn/T/dev-log-test-full-2026-10-18_21-37/user/full-ui.check.ts-Rollen-Autorin-sieht-nur-was-sie-darf-handy/error-context.md

  11 failed
    [desktop] › e2e/full-ui.check.ts:307:1 › Tabellen: Sortieren, Filtern, Suchen und Zurücksetzen auf allen Seiten 
    [desktop] › e2e/full-ui.check.ts:406:1 › Jeder Knopf und Link: anklicken, Dialoge bearbeiten und speichern, ohne Fehler 
    [desktop] › e2e/full-ui.check.ts:518:1 › Dashboard: Kennzahlen, Links und Agent-Aufgaben ───────
    [desktop] › e2e/full-ui.check.ts:539:1 › Auftrag: anlegen, Status ändern, erneut versuchen, analysieren, löschen 
    [desktop] › e2e/full-ui.check.ts:581:1 › Ideen: anlegen, öffnen, kommentieren, Auftrag erstellen lassen 
    [desktop] › e2e/full-ui.check.ts:636:1 › Sprints: Datum prüfen, anlegen, Board öffnen, starten ─
    [desktop] › e2e/full-ui.check.ts:694:1 › Agents: anlegen, Reihenfolge, aktivieren, Detailansicht 
    [desktop] › e2e/full-ui.check.ts:767:1 › Projektwechsel trennt die Daten ───────────────────────
    [desktop] › e2e/full-ui.check.ts:785:1 › Rollen: Autorin sieht nur, was sie darf ───────────────
    [handy] › e2e/full-ui.check.ts:406:1 › Jeder Knopf und Link: anklicken, Dialoge bearbeiten und speichern, ohne Fehler 
    [handy] › e2e/full-ui.check.ts:785:1 › Rollen: Autorin sieht nur, was sie darf ─────────────────
  9 skipped
  6 passed (11.4m)
```

</details>

