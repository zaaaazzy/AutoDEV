# Offene Testnachweise als Aktion mit Testlauf-Knopf

Auftrag f4e84f70-a86f-47ca-bd3d-6c984eedbada (Feature).

## Ziel

Tester und Dokumentierer meldeten Tests, die sie nicht ausführen konnten (Befehl gesperrt, Gegenprobe offen), nur im Freitext. Solche Lücken gingen unter. Jetzt werden sie strukturiert gemeldet und unter „Aktion notwendig“ mit einem Testlauf-Knopf angeboten.

## Umsetzung

- **Marker:** `@@NACHWEIS {"datei":…,"befehl":…,"grund":…}`. Gültige Gründe: `nicht_freigegeben`, `gegenprobe_fehlt`. Parser `parseEvidence` und Anweisung in `src/runner/acceptance.ts`, Rollenzuordnung in `src/runner/runner-prompts.ts`.
- **Speichern:** `runner-steps.ts` übernimmt die Zeilen nach dem Schritt in die neue Tabelle `test_evidence` (Status `open`) und entfernt die Markerzeilen aus Schrittausgabe und Auftragsdoku. Eindeutig je `(development_id, befehl)`. Unbekannte Gründe, fehlende Befehle und kaputtes JSON werden verworfen.
- **Migration 19 `testnachweise`** (`src/db/migrations.ts`): Tabelle `test_evidence`, Spalte `test_requests.evidence_id`, `test_requests.scope` um `'befehl'` erweitert (`DROP CONSTRAINT IF EXISTS` / `ADD CONSTRAINT`, alle bisherigen Werte bleiben erlaubt). Idempotent.
- **Start:** `POST /projects/:slug/test-evidence/:id/run` (`src/api/test-requests.ts`, Rolle `run`). Nur die ID zählt; ein Body mit Befehl ergibt 400. Läuft ein Test des Projekts, antwortet der Endpunkt mit 409.
- **Worker:** `processTestRequest` (`src/runner/test-request.ts`) hat einen Zweig für Umfang `befehl`. Der Befehl wird aus der gespeicherten Zeile gelesen, mit `isAllowedCommand` geprüft (bei Ablehnung: nichts startet, Status `nicht_freigegeben`) und mit `shellWords` als Argumentliste ohne Shell im Testcontainer ausgeführt. Ergebnis: grün → `passed` mit `run_id` und `checked_at`; rot → `failed` mit `run_id`, Eintrag bleibt sichtbar.
- **Oberfläche:** „Aktionen“ zeigt je Nachweis Datei, Befehl, Grund, Startknopf (nur mit `auth.can('run')`, gesperrt bei laufendem Test) oder bei `nicht_freigegeben` einen Link zu den Rechte-Kategorien. `order-attention.ts` führt einen zusätzlichen Grund ein, bestehende Texte bleiben. Die Übersicht und die Menü-Bubble zählen Aufträge mit offenem Nachweis mit, auch bei leerem `action_todo`.
- **Unverändert:** `action_todo`, Autopilot, Sprintabschluss, `@@ACCEPTANCE`/`@@CHECK`.

## Geänderte Dateien

- `src/db/migrations.ts`
- `src/runner/acceptance.ts`, `runner-prompts.ts`, `runner-steps.ts`, `test-request.ts`
- `src/api/test-requests.ts`
- `src/runner/test-evidence.test.ts`, `src/api/test-evidence.test.ts`
- `frontend/src/app/core/models.ts`, `project-loader.ts`, `project-store.ts`
- `frontend/src/app/shared/order-attention.ts`, `order-attention.spec.ts`, `attention-card.ts`
- `frontend/src/app/features/actions/actions.component.ts`, `.html`
- `frontend/src/app/features/settings/permission-groups-settings.component.html`
- `frontend/src/styles/09-dashboard.css`
- `docs/agents-und-rechte.md` (technische Doku: Marker, Knopf, Rechte-Verweis)
- `docs/benutzerhandbuch-testnachweise-als-aktion.md`
- `docs/offene-testnachweise-als-aktion-2026-10-30.md` (diese Datei)

## Worauf zu achten ist

- Die Migration muss vor dem Neustart des Workers laufen (`launchctl kickstart` laut `docs/agents-und-rechte.md`), sonst kennt der Worker `test_evidence` nicht.
- Der Befehl stammt aus Agent-Ausgabe und ist nicht vertrauenswürdig: Start nur per Klick, `isAllowedCommand`, keine Shell, Testcontainer. `isAllowedCommand` muss zu den Rechtegruppen in `src/agent/permission-rules.ts` passen.
- Spätere Änderungen an `test_requests_scope_check` müssen alle geschriebenen Werte behalten (`file`, `project`, `befehl` usw.).
- Alt-Aufträge ohne strukturierte Nachweise erscheinen nur, wenn der Tester sie neu meldet.
- Mehrere Befehle werden als mehrere Nachweise gemeldet.

## Nacharbeit nach dem ersten Testerlauf

Der erste Testerlauf scheiterte an der Umgebung (`tsc` fehlt im Image, npm-Cache ohne Schreibrecht), nicht am Code. Der Code wurde gegen die Akzeptanzkriterien gegengelesen. Dabei gab es zwei Korrekturen:

- `test-request.ts`: Bricht ein Lauf nach dem Anlegen ab, gilt der Nachweis als rot (`failed` mit diesem Lauf). Das gilt jetzt auch beim erneuten Start eines schon roten Nachweises; bisher blieb dort die alte `run_id` stehen.
- `test-evidence.test.ts`: Migration 19 läuft zusätzlich auf einer Tabelle mit bestehenden Zeilen `full`, `ui` und `befehl`.

## Offen

- Printscreens der Seite „Aktionen“ (mit Startknopf und mit Rechte-Link) fehlen im Benutzerhandbuch; in der Sitzung gab es keinen Browser. Nachreichen, sobald die App läuft.
- Ob `npm test` und Build grün sind, ist hier nicht neu geprüft; das ist Sache des Testers.

## Sprint und Anfrage/TODO

| Auftrag | Zustand | Details |
|---|---|---|
| f4e84f70 Offene Testnachweise als Aktion | umgesetzt, Tests geschrieben, wartet auf Tester | Migration 19, Endpunkt, Worker-Zweig, Oberfläche, Doku |

- Anfrage/TODO: Printscreens nachreichen. Worker nach der Migration neu starten. Tester soll Schema-Test (jede Fassung der Scope-Prüfung gegen alle geschriebenen Werte), Wiederholbarkeit der Migration und die Oberflächentests (E2E, `full-ui.check.ts`) für den neuen Knopf prüfen.
