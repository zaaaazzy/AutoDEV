# Feste Coverage-Bereiche mit Pflichtwerten und Zeitreihe

Auftrag 3ad55799 (30.10.2026).

## Was sich ändert

- **Feste Liste** (`COVERAGE_AREAS` in `src/runner/coverage.ts`): `backend`, `frontend`, `scripts`, `e2e`, `gesamt`, `auftrag`. Speicherung, Messung und Anzeige verwenden nur diese Namen. Ein neuer Bereich braucht eine Codeänderung. `auftrag` steht für die Abdeckung des vom Auftrag geänderten Codes.
- **Gemeinsamer Validator** (`validateCoverage`): Eine Meldung wird nur angenommen, wenn jeder gemeldete Bereich zur Liste gehört, `lines` und `branches` als Zahl von 0 bis 100 hat und mindestens einen Testfall (`unit + component + integration + e2e > 0`). `null`, Text statt Zahl, doppelte oder unbekannte Bereiche lehnen die ganze Meldung ab. `saveCoverage` prüft vor dem Schreiben erneut und wirft sonst `CoverageValidationError`.
- **Nicht alle sechs Pflicht:** Gemeldet werden nur gemessene Bereiche. Würde jede Meldung alle sechs verlangen, könnte die Messung durch AIdeation (in der Regel nur `gesamt`) nie einen gültigen Bericht erzeugen, und jede Abnahme wäre blockiert.
- **Runner** (`src/runner/runner-steps.ts`): Ein ungültiger `@@COVERAGE`-Block wird verworfen. Der Grund steht im Schrittverlauf und am Ende der Ausgabe („Testabdeckung des Testers verworfen: …“). Die eigene Messung bleibt, sofern sie gültig ist. Die Messung läuft jetzt **vor** der Abnahme, damit die Abnahme weiß, ob ein gültiger Bericht gespeichert wurde.
- **Messung durch AIdeation** (`src/runner/measured-coverage.ts`): `areaName` nutzt dieselbe Zuordnung (`COVERAGE_AREA_ALIASES`). Eine Messung im Projektordner heißt `gesamt`, ein Workspace wird über ganze Namensteile zugeordnet (`mainty-backend` → `backend`, `shop-ui` → `frontend`, `tools` → `scripts`). Workspaces ohne Zuordnung (z. B. `contracts`) werden nicht gemessen; der Schritt nennt den Grund. `mergeCoverage` prüft jede Messung mit dem Validator und gibt `{ report, errors }` zurück.
- **Abnahme** (`src/runner/acceptance.ts`): `waiveUnmeasuredCoverage` bekommt `measured`. Ein DoD-Punkt „Abdeckung nicht gemessen“ gilt nur dann als erfüllt, wenn trotzdem ein gültiger Bericht gespeichert wurde. Ohne Messung bleibt er offen. `null` ist aus `NOT_MEASURED` entfernt: Ein Hinweis auf null-Werte belegt keine Messung mehr.
- **Tester-Prompt** (`COVERAGE_INSTRUCTIONS`): nennt die sechs Namen, verbietet `null` und Bereiche ohne Tests. Der frühere Hinweis „melde die Prozentwerte als null“ ist entfallen.
- **Migration 20** (`coverage-feste-bereiche`): legt `coverage_area_aliases (alias PK, area)` an und füllt sie mit den bekannten Schreibweisen (gleich `COVERAGE_AREA_ALIASES`, ein Test hält beides gleich). Danach werden alle `test_coverage_areas.area` über `lower(btrim(area))` umgeschrieben. Mehrere Einträge eines Berichts für denselben Bereich werden vorher in einer temporären Tabelle zusammengeführt: Testzahlen summiert, Prozentwerte gemittelt, `NULL` bleibt `NULL`. Einträge ohne Zuordnung bleiben unverändert. Gelöscht wird nichts außer den Zeilen, die zusammengeführt neu eingefügt werden.
- **Version 19 ist frei:** Der Auftrag verlangt Version 20. Version 19 ist für einen parallel entstandenen Schritt reserviert. Der Lückentest in `src/db/migrations.test.ts` lässt nur diese eine Lücke zu (`RESERVED_VERSIONS`).
- **API** (`src/api/coverage.ts`):
  - `GET /projects/:slug/coverage/trend` liefert je fester Bereich die Punkte `{ reportId, date, lines, branches, tests }`, nach Datum aufsteigend, aus den letzten 200 Berichten. Altbestand ohne Zuordnung wird ausgeblendet.
  - Neuer Schreibweg `POST /projects/:slug/coverage` (Rolle „Agents ausführen“), z. B. für CI. Er nutzt denselben Validator und antwortet bei Fehlern mit **400** und einer Meldung wie „Testabdeckung abgelehnt: Bereich backend: 0 Testfälle.“. Dann wird nichts gespeichert.
  - `GET /projects/:slug/coverage` (Dashboard-Kachel) bleibt beim neuesten Bericht.
- **Oberfläche:** Die Statistik zeigt neu „Testabdeckung im Verlauf“ (`frontend/src/app/features/stats/coverage-trend.component.ts`): je Bereich ein kleines Liniendiagramm (Zeilen durchgezogen mit Kreisen, Zweige gestrichelt mit Quadraten, Ziellinie 75 %), Tooltip je Punkt und Tabelle zum Aufklappen. Fehlende Werte bilden eine Lücke. Lesen braucht wie die API keine Rolle. Die Dashboard-Kachel rechnet keine zweite Summenzeile, wenn der Bericht `gesamt` selbst enthält.

## Geänderte Dateien

- Backend: `src/db/migrations.ts`, `src/runner/coverage.ts`, `src/runner/measured-coverage.ts`, `src/runner/runner-steps.ts`, `src/runner/acceptance.ts`, `src/api/coverage.ts`.
- Frontend: `frontend/src/app/core/models.ts`, `features/dashboard/coverage-panel.component.ts`, `features/stats/` (`coverage-trend.ts`, `coverage-trend.component.ts`, `stats.component.*`), `frontend/src/styles/09-dashboard.css`.
- Tests: `src/db/migrations.test.ts`, `src/api/coverage.test.ts`, `src/runner/{coverage,measured-coverage,acceptance,runner}.test.ts`, `coverage-trend.spec.ts`.
- Doku: `docs/agent-tests.md` (Pflichtwerte statt „nicht als null melden“), `docs/benutzerhandbuch-dashboard-agents.md`.

## Offen / TODO

- **Migrationsnummer:** Die Migration trägt wie verlangt Version 20; Version 19 ist im Lückentest als reserviert eingetragen. Gibt es keinen parallelen Schritt 19, auf 19 umnummerieren und `RESERVED_VERSIONS` entfernen (Entscheidung beim Auftraggeber).
- `full-ui.check.ts` (Oberflächentest) wurde in dieser Doku-Phase nicht geprüft; bei Änderungen an der Statistik-Ansicht mitführen.

## Worauf zu achten ist

- **Reihenfolge beim Ausrollen:** Migration und Runner gehören in denselben Stand. Ein alter Worker, der noch Freitext-Namen schreibt, wird nicht blockiert (keine CHECK-Prüfung auf `test_coverage_areas.area`). Seine Einträge erscheinen nur nicht in der Zeitreihe.
- **Neue Schreibweisen:** in `COVERAGE_AREA_ALIASES` ergänzen und per neuer Migration in `coverage_area_aliases` eintragen. Migration 20 nicht ändern.
- **Test-Gate:** hat keinen eigenen Prompt und erzeugt keinen Abdeckungsbericht; unverändert.
- Ein Validator-Lauf für die Diagrammfarben war in der Agent-Umgebung gesperrt. Die Farben (Grün und Orange aus dem Theme) unterscheiden sich stark in der Helligkeit. Zweige tragen zusätzlich Strichelung und eine andere Markerform.
