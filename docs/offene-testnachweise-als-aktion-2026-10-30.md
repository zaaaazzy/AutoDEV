# Offene Testnachweise als Aktion mit Testlauf-Knopf

Auftrag f4e84f70-a86f-47ca-bd3d-6c984eedbada (Feature).

## Ziel

Tester und Dokumentierer meldeten Tests, die sie nicht ausführen konnten (Befehl gesperrt, Gegenprobe offen), nur im Freitext. Solche Lücken gingen unter. Jetzt werden sie strukturiert gemeldet und unter „Aktion notwendig“ mit einem Testlauf-Knopf angeboten.

## Umsetzung

- **Marker:** `@@NACHWEIS {"datei":…,"befehl":…,"grund":…}`. Gültige Gründe: `nicht_freigegeben`, `gegenprobe_fehlt`. Parser `parseEvidence` und Anweisung in `src/runner/acceptance.ts`, Rollenzuordnung in `src/runner/runner-prompts.ts`.
- **Speichern:** `runner-steps.ts` übernimmt die Zeilen nach dem Schritt in die neue Tabelle `test_evidence` (Status `open`) und entfernt die Markerzeilen aus Schrittausgabe und Auftragsdoku. Eindeutig je `(development_id, befehl)`. Unbekannte Gründe, fehlende Befehle und kaputtes JSON werden verworfen.
- **Migration 22 `testnachweise`** (`src/db/migrations.ts`): Tabelle `test_evidence`, Spalte `test_requests.evidence_id`, `test_requests.scope` um `'befehl'` erweitert (`DROP CONSTRAINT IF EXISTS` / `ADD CONSTRAINT`, alle bisherigen Werte bleiben erlaubt). Idempotent.
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

## Erneuter Versuch (30.10.2026, Entwickler)

Laut Analyse sollte vorher in einem eigenen Auftrag das Agent-Image samt `node_modules`-Volume korrigiert werden. Das ist noch nicht passiert. `node_modules` im Arbeitsordner verweist auf einen Host-Pfad (`/Volumes/…/source/node_modules`), der im Container nicht eingehängt ist. `npm run typecheck` endet weiterhin mit `tsc: not found` (Exit 127). Am Code gab es nichts zu ändern. Gegen die Akzeptanzkriterien gegengelesen wurden: Migration 19, `parseEvidence`/`stripEvidence`, das Speichern in `runner-steps.ts` vor `afterStep`, sodass die Auftragsdoku des Dokumentierers die bereinigte Ausgabe erhält, außerdem die Antworten 400/409/422 des Endpunkts, der Worker-Zweig `befehl` sowie Knopf und Rechte-Link in „Aktionen“. Ein grüner Lauf ist erst möglich, wenn der Image-Auftrag erledigt ist.

## Dritter Versuch (30.10.2026, Entwickler)

Die Umgebung ist unverändert: `node_modules` verweist auf einen Host-Pfad, `npm run typecheck` endet mit `tsc: not found` (Exit 127). Der Code wurde erneut gegen die Akzeptanzkriterien gegengelesen. Dabei gab es eine Korrektur:

- `saveEvidence` (`src/runner/acceptance.ts`): Ein Nachweis mit Grund `nicht_freigegeben` blieb bisher auch dann ohne Startknopf, wenn der Befehl später freigegeben wurde. Grund war `ON CONFLICT DO NOTHING`, und die Neumeldung desselben Befehls änderte nichts. Jetzt hebt eine Neumeldung mit `gegenprobe_fehlt` einen offenen Nachweis mit `nicht_freigegeben` auf `gegenprobe_fehlt`/`open`. Es entsteht keine zweite Zeile, und der Rückgabewert zählt weiterhin nur neue Zeilen (`xmax = 0`). Abgehakte Nachweise und Zurückstufungen bleiben unberührt. Der Test steht in `src/runner/test-evidence.test.ts`.

## Merge mit sprint/sprint-30 (30.10.2026, Entwickler)

`sprint/sprint-30` hatte die Migrationsnummern 19 (`ein-auftrag-je-idee`), 20 (`sprints-projekt-index`) und 21 (`agent-sandbox-arbeitscontainer`) schon belegt. Die Migration `testnachweise` ist deshalb jetzt **Version 22**. Beide Seiten bleiben vollständig erhalten. Angepasst wurden `src/runner/test-evidence.test.ts` (Wiederholung von Migration 22) sowie die Verweise in `docs/agents-und-rechte.md`, `docs/erm.md` und diesem Dokument. Achtung bei Entwicklungs-Datenbanken, die schon die alte Version 19 `testnachweise` vom Auftrags-Branch erhalten haben: `runMigrations` vergleicht nur Nummern und würde `ein-auftrag-je-idee` dort stillschweigend überspringen. Vorher prüfen: `SELECT version, name FROM schema_migrations WHERE version = 19`. Steht dort `testnachweise`, diese Zeile löschen, dann laufen 19 und 22 neu. Beide sind wiederholbar. Diese Fassung des Branches wurde nie ausgeliefert. Im Arbeitscontainer liefen Typprüfung und Tests wieder nicht: `node_modules` ist unvollständig, und `npm ci --ignore-scripts` scheitert an `/home/agent/.npm` (EACCES).

## Teststand (Dokumentierer)

Der Tester konnte `npm run typecheck` und `npx tsx --test …` im Image „aideation-agent“ nicht ausführen (`tsc` fehlt, `/home/agent/.npm` nicht beschreibbar). Es gibt daher keinen grünen Lauf für diesen Auftrag. Die Testdateien sind geschrieben, aber ungeprüft: `src/runner/test-evidence.test.ts`, `src/api/test-evidence.test.ts`, `frontend/src/app/shared/order-attention.spec.ts`, `src/db/migrations.test.ts`, `src/runner/acceptance.test.ts`, `src/runner/runner-steps.test.ts`, `src/runner/test-request.test.ts`. Ein Mensch oder eine Umgebung mit `tsc` und beschreibbarem npm-Cache (`npm_config_cache` setzen) muss `npm run typecheck`, `npm test` und den Build ausführen.

Auch der letzte Testerlauf (30.10.2026) endete ohne Ergebnis: `npm run typecheck` → `tsc: not found` (Exit 127), `npx tsx --test …` → `EACCES` auf `/home/agent/.npm/_cacache`. Beides ist ein Umgebungsfehler, kein Befund am Code. Die beiden Befehle stehen deshalb als Testnachweise (`gegenprobe_fehlt`) offen.

## Offen

- Printscreens der Seite „Aktionen“ (mit Startknopf und mit Rechte-Link) fehlen im Benutzerhandbuch; in der Sitzung gab es keinen Browser. Nachreichen, sobald die App läuft.
- Ob `npm test` und Build grün sind, ist hier nicht neu geprüft; das ist Sache des Testers.

## Sprint und Anfrage/TODO

| Auftrag | Zustand | Details |
|---|---|---|
| f4e84f70 Offene Testnachweise als Aktion | umgesetzt, Tests geschrieben, wartet auf Tester | Migration 22, Endpunkt, Worker-Zweig, Oberfläche, Doku |

- Anfrage/TODO: Printscreens nachreichen. Worker nach der Migration neu starten. Tester soll Schema-Test (jede Fassung der Scope-Prüfung gegen alle geschriebenen Werte), Wiederholbarkeit der Migration und die Oberflächentests (E2E, `full-ui.check.ts`) für den neuen Knopf prüfen.
