# Testabdeckung: feste Bereichsschlüssel, neuester vollständiger Lauf, Verlauf

## Aufträge

### Auftrag 80ae16ac

„Coverage-Bereiche auf feste Schlüssel umstellen“. Agent „Entwickler“ hat umgesetzt, diese Seite dokumentiert das Ergebnis.

**Ergebnis:** Testabdeckung wird nur noch unter den sechs festen Schlüsseln `backend`, `frontend`, `contracts`, `scripts`, `e2e`, `gesamt` gespeichert. Eine gemeldete Bezeichnung wird über `coverageAreaKey` zugeordnet, nicht über den freien Text. Nicht zuordenbare und unvollständige Einträge werden verworfen, der Grund steht im Schritt-Log. Die Übersicht zeigt je Schlüssel höchstens eine Zeile mit dem neuesten vollständigen Lauf (Zeilen-, Verzweigungs- und Funktionsabdeckung gesetzt) und eigenem Datum. Die Statistik hat einen Abschnitt „Testabdeckung-Verlauf“. Eine Migration bereinigt den Bestand.

**Anforderung → Umsetzung**

- **Schlüssel und Zuordnung** (`src/core/coverage-areas.ts`, neu): `COVERAGE_AREA_KEYS`, `COVERAGE_AREA_LABELS` (Oberfläche), `isCoverageAreaKey`, `coverageAreaKey(label)`, `isCompleteCoverage`, `COMPLETE_COVERAGE_SQL`. Ganzwortprüfung (`builder` ist kein `ui`). Reihenfolge der Regeln:
  1. `gesamt`: „gesamt“, „zusammen“, „insgesamt“ oder Backend- und Frontend-Wort zusammen.
  2. `backend` (backend, server, api), 3. `frontend` (frontend, web, ui, client), 4. `contracts` (contract, shared, common), 5. `scripts` (script, skript, skripte), 6. `e2e` (e2e, end-to-end, playwright).
  - Beispiele: „Backend (Express)“ → `backend`; „Backend und Frontend (zusammen)“ → `gesamt`; „Projekt“ → kein Schlüssel.
- **Speichern und Verwerfen** (`src/runner/coverage.ts`): `parseCoverage` und `saveCoverage` wenden die Zuordnung an. `saveCoverage` liefert `discarded` (Gründe) zurück. Verworfen wird, was keinem Schlüssel entspricht oder keine Prozentwerte hat. Der Tester-Prompt (`COVERAGE_INSTRUCTIONS`) nennt als Beispiele nur die festen Schlüssel.
- **Messung** (`src/runner/measured-coverage.ts`): `areaName` liefert Schlüssel statt Labels, `mergeCoverage` vergleicht Schlüssel. `measureCoverage` selbst ist unverändert.
- **Schritt-Log** (`src/runner/runner-steps.ts`): Nach dem Speichern wird je verworfenem Bereich `Testabdeckung: <Grund>` protokolliert.
- **API** (`src/api/coverage.ts`):
  - `GET /projects/:slug/coverage`: letzter Bericht (Zusammenfassung, Auftrag) und je Schlüssel eine Zeile (`DISTINCT ON (a.area)`, vollständige Läufe zuerst, dann neuestes Datum). Hat ein Schlüssel keinen vollständigen Lauf, kommt sein neuester Eintrag mit `complete: false` und leeren Prozentwerten (Anzeige „–“). Sortiert in Reihenfolge der Schlüssel. Jede Zeile hat `createdAt`.
  - `GET /projects/:slug/coverage/history` (neu): Zeilenabdeckung vollständiger Läufe je Schlüssel, höchstens `HISTORY_LIMIT` (60) neueste Punkte, aufsteigend nach Datum. Registrierung in `app.ts` bestand schon.
- **Visionär** (`src/agent/visionary.ts`): dieselbe Regel „neuester vollständiger Lauf je Schlüssel“.
- **Migration** (`src/db/migrations.ts`, `testabdeckung-feste-bereiche`): siehe unten.
- **Frontend:** Typ `CoverageArea.area` als Schlüssel-Union und Verlauf in `models.ts`; `project-loader.ts` lädt den Verlauf; `coverage-panel.component.*` zeigt feste Zeilen mit Datum je Zeile, die Mittelwert-Summenzeile entfällt; `stats.component.*` zeigt den Abschnitt „Testabdeckung-Verlauf“, die Aufbereitung der Punkte liegt in `features/stats/coverage-history.ts`; Styles in `09-dashboard.css`.
- **Doku:** `docs/benutzerhandbuch-dashboard-agents.md` angepasst.
- `gesamt` berechnet der Worker nicht. Die Zeile erscheint nur, wenn ein Lauf sie unter diesem Schlüssel meldet.

**Migration (Version 23)**

Die Migrationsnummer ist **23, nicht 20** wie im Auftrag. Die Nummern sind fortlaufend. Beim Nachziehen von `sprint/sprint-30` waren die Versionen 19–22 schon belegt (`ein-auftrag-je-idee`, `sprints-projekt-index`, `agent-sandbox-arbeitscontainer`, `testnachweise`). Die Coverage-Migration, auf dem Auftrags-Branch zuerst Version 19, ist deshalb jetzt Version 23. Die Kommentare in `coverage-areas.ts` nennen ebenfalls 23.

1. Sicherung: `test_coverage_areas_backup_23` (`CREATE TABLE IF NOT EXISTS … AS TABLE`).
2. Alten Constraint entfernen (`DROP CONSTRAINT IF EXISTS`), temporäre Zuordnungstabelle `coverage_area_keys` per `CASE` auf `lower(btrim(area))` mit denselben Regeln und Reihenfolge wie `coverageAreaKey`.
3. Löschen: Zeilen ohne Zuordnung und Zeilen, bei denen Zeilen-, Statement-, Verzweigungs- und Funktionswert alle `NULL` sind.
4. Duplikate je (`report_id`, Schlüssel): der höchste Zeilenwert bleibt.
5. `UPDATE` auf den Schlüssel, dann `CHECK (area IN ('backend', 'frontend', 'contracts', 'scripts', 'e2e', 'gesamt'))` als `test_coverage_areas_area_check`.

Die alten Berichte bleiben als Verlaufsquelle. Die Zählungen werden nicht neu berechnet. `src/db/schema.ts` ist unverändert.

**Geänderte Dateien**

- Neu: `src/core/coverage-areas.ts`, `src/core/coverage-areas.test.ts`, `frontend/src/app/features/stats/coverage-history.ts`, `coverage-history.spec.ts`.
- Backend: `src/api/coverage.ts`, `src/agent/visionary.ts`, `src/db/migrations.ts`, `src/runner/{coverage,measured-coverage,runner-steps}.ts`.
- Tests: `src/agent/visionary.test.ts`, `src/db/migrations.test.ts`, `src/runner/{coverage,measured-coverage,project-command,runner}.test.ts`, `frontend/src/app/core/project-loader.spec.ts`.
- Frontend: `frontend/src/app/core/{models,project-loader}.ts`, `features/dashboard/coverage-panel.component.{ts,html}`, `features/stats/stats.component.{ts,html}`, `frontend/src/styles/09-dashboard.css`.
- Doku: `docs/benutzerhandbuch-dashboard-agents.md`.
- Umgebung: `deploy/agent/Dockerfile` (npm-Cache), `frontend/tsconfig.app.json`, `frontend/tsconfig.spec.json`.

**Tests**

Der Entwickler hat Tests ergänzt oder angepasst für Zuordnung, Verwerfen, Vollständigkeitsprüfung, Migration und Verlauf (`coverage-areas.test.ts`, `coverage.test.ts`, `measured-coverage.test.ts`, `project-command.test.ts`, `migrations.test.ts`, `visionary.test.ts`, `runner.test.ts`, `project-loader.spec.ts`, `coverage-history.spec.ts`). Laut Entwicklerbericht (erneuter Versuch im Arbeitscontainer) ist `npm test` grün, und die Migrationstests sind gegen eine echte Datenbank gelaufen. Die Dokumentation hat die Läufe nicht selbst wiederholt.

**Nicht umgesetzt oder offen**

- `e2e/demo/seed.ts` wurde nicht geändert und braucht es nicht: Die Demo-Daten legen nur die Bereiche `backend` und `frontend` an (Zeilen 1197–1200), beide feste Schlüssel, der CHECK-Constraint lehnt sie nicht ab.
- **Testschritt fehlgeschlagen, aber aus Umgebungsgründen:** Der Tester konnte nichts ausführen. `npm run typecheck` scheiterte mit `tsc: not found` (Sandbox-Image „aideation-agent“, Exit-Code 127), `npx tsx --test …` mit `EACCES` auf dem npm-Cache (`/home/agent/.npm`). Es gibt also weder einen grünen noch einen roten Testlauf des Codes; die Abnahme „`npm test` vollständig grün“ ist offen. Tests nur über `npm test` bzw. `npm run …` starten, nicht über `npx tsx`.
- **Erneuter Versuch (30.10.2026 12:23):** Der Hinweis lautet, das Image „aideation-agent“ zu korrigieren, neu zu bauen und danach den `node_modules`-Volume des Projekts zu befüllen. Das ist eine Umgebungsaufgabe, keine Codeänderung; im Repository wurde dafür nichts geändert. Der Tester-Schritt davor scheiterte weiter an `tsc: not found` und `EACCES` auf `/home/agent/.npm`.
- **Image-Korrektur im erneuten Versuch:** Geändert wurde `deploy/agent/Dockerfile`. Der npm-Install als root mit `HOME=/home/agent` hinterließ einen root-eigenen npm-Cache, daher `EACCES` bei jedem `npm`/`npx` des Agents. Das Image räumt den Cache jetzt auf (`npm cache clean --force`, `rm -rf /home/agent/.npm`), und `/home/agent` sowie `/workspace` sind für alle beschreibbar (`chmod 1777`). Das Image muss neu gebaut werden (`docker build -t aideation-agent -f deploy/agent/Dockerfile .`), erst dann wirkt die Korrektur. `tsc: not found` bleibt, bis der `node_modules`-Volume des Projekts befüllt ist (`npm ci`). Das habe ich nicht geprüft. Zusätzlich liegen Änderungen an `frontend/tsconfig.app.json` und `frontend/tsconfig.spec.json` vor, die der Entwickler aus dem vorherigen Versuch mitgeführt hat.
- **Stand nach dem erneuten Versuch:** Der Entwickler hat im Arbeitscontainer umgesetzt und getestet: `npm test` grün, Migrationstests gegen eine echte Datenbank. Die oben genannten Umgebungsprobleme (Tester-Schritt) betreffen damit nur den früheren Versuch. Ein Browser-Check der Oberfläche steht noch aus.

**Worauf zu achten ist**

- Die Schlüsselliste steht dreifach: `coverage-areas.ts`, CHECK in der Migration, Frontend-Union. Ändert sich eine, müssen alle angepasst werden (neue Migration, die Version 23 nicht ändern). Ein Test in `migrations.test.ts` soll prüfen, dass jeder Schlüssel den Constraint besteht.
- Die Zuordnung ist eine Heuristik. Bezeichnungen wie „Projekt“ fallen weg, Altdaten mit mehrdeutigen Namen können dem „falschen“ Schlüssel zugeordnet sein; Verlaufsdaten sind nur so gut wie diese Zuordnung.
- Fehlt einem Lauf ein Prozentwert (z. B. keine Messung, `null`), wird er nicht still ignoriert: Er wird verworfen und der Grund steht im Schritt-Log. In der Übersicht erscheint ein Schlüssel ohne vollständigen Lauf mit „–“.
- Die Migration löscht Altzeilen; Wiederherstellung über `test_coverage_areas_backup_23`. Ein zweiter Start führt Migration 23 nicht erneut aus.
- Mehrere Einträge mit demselben Schlüssel im selben Bericht sind nach der Migration nicht mehr möglich; beim Speichern gilt dieselbe Regel (höchster Zeilenwert).
- `COVERAGE_TARGET` (75 %) und die Zählung der Testarten sind unverändert.

## Sprint

| Auftrag | Inhalt | Zustand |
| --- | --- | --- |
| 80ae16ac | Coverage-Bereiche auf feste Schlüssel umstellen | Entwickler fertig (`npm test` grün, Migrationstests gegen echte Datenbank), Dokumentation hier; Abnahme durch den Tester, Review und Merge offen |

## Anfrage / TODO

- Image `aideation-agent` mit dem korrigierten Dockerfile neu bauen, dann den `node_modules`-Volume des Projekts befüllen (nur nötig, wenn spätere Sandbox-Läufe weiter `tsc: not found` oder `EACCES` melden).
- Abnahme: `npm run typecheck` und `npm test` im Testschritt bestätigen; die Migration auf einer Datenbank mit Altbestand und einen zweiten Start prüfen.
- Nach der Migration Übersicht und Statistik im Browser ansehen: je Schlüssel eine Zeile, Datum je Zeile, Verlauf je Schlüssel.
- Optional später: Sicherungstabelle `test_coverage_areas_backup_23` entfernen, wenn die Zuordnung der Altdaten abgenommen ist.

## Technische Dokumentation

- Datenfluss: Tester-Block `@@COVERAGE` und Messung (AIdeation) → `coverageAreaKey` → unbekannt oder ohne Prozentwerte: verwerfen und im Schritt-Log nennen; sonst `test_coverage_areas` (CHECK auf sechs Schlüssel) → Übersicht (neuester vollständiger Lauf je Schlüssel) und Statistik (Verlauf je Schlüssel).
- Tabellen: `test_coverage_reports` (`id`, `project_slug`, `development_id`, `created_at`) 1:n `test_coverage_areas` (`report_id`, `area`, `lines`, `statements`, `branches`, `functions`, Testzählungen).
- API: `GET /projects/:slug/coverage`, `GET /projects/:slug/coverage/history` (beide `access({ tenant: 'project' })`, nur lesend).
- Code: `src/core/coverage-areas.ts`, `src/runner/coverage.ts`, `src/runner/measured-coverage.ts`, `src/runner/runner-steps.ts`, `src/api/coverage.ts`, `src/agent/visionary.ts`, `src/db/migrations.ts` (Version 23), `frontend/src/app/features/dashboard/coverage-panel.component.*`, `frontend/src/app/features/stats/`.
- Benutzerhandbuch: `docs/benutzerhandbuch-dashboard-agents.md`.
