# Mandanten-Prüfung für alle ID-Felder per Allowlist-Test

Auftrag 852db391 (30.10.2026, im Arbeitscontainer erneut geprüft am 31.10.2026). Folgt auf den Vorfall in
`docs/auftraege/agent-handoff-nur-eigenes-projekt-2026-10-25.md`.

## Aufträge

### Was umgesetzt wurde

- **Gemeinsamer Helfer `assertInProject(pool, tabelle, id, projektSlug)`** in `src/api/tenancy.ts`. Er nimmt eine ID oder eine Liste von IDs und prüft über `project_slug`, ob alles zum Projekt gehört. Ohne ID (`null`, leere Liste) gibt es nichts zu prüfen (`true`). Tabellen kommen nur aus der festen Liste `PROJECT_TABLES`, nie aus Eingabe. Er nutzt den Projekt-Slug, nicht eine numerische ID.
- **`agentInProject` ist entfernt.** Die Aufrufe in `agent-tasks.ts` und `agents.ts` (`PATCH /agents/:id`, `handoffTo`) nutzen den neuen Helfer. Verhalten von `handoffTo` unverändert: fremde ID 400, `null` erlaubt.
- **Allowlist `src/api/tenant-id-fields.ts`** (`TENANT_ID_FIELDS`): je Eintrag Methode, Pfad, Ort (Pfad/Body), Feldname, Tabelle und erwarteter Ablehnungscode. `TENANT_ID_EXEMPT` führt ID-artige Felder ohne Projekt-Datensatz mit Begründung auf.
- **Weitere Routen**, die mit `assertInProject` vor dem Schreiben prüfen: `development.ts`, `sprints.ts`, `workflow.ts`, `worker.ts`, `test-runs.ts`. `bugs.ts`, `chat-routes.ts`, `sprint-planning.ts`, `permission-groups.ts` und `test-requests.ts` prüfen mit gleichwertigen Abfragen (z. B. Projekt und Sprintstatus in einem Schritt); der Test belegt das Verhalten für jede dieser Routen.
- **`review-routes.ts` unverändert**: `developmentId` bleibt bei 404, steht aber in der Allowlist.
- **Integrationstest `src/api/tenant-ids.test.ts`**:
  - liest die registrierten Express-Routen (`createApiRouter`) samt Quelltext und scheitert, wenn eine Route mit ID-Feld nicht in der Allowlist steht (und umgekehrt, wenn ein Eintrag keine Route mehr ist);
  - schickt je Eintrag eine gültige ID aus dem Projekt „fremd“, erwartet 400/404 und vergleicht Zeilenzahl und Inhalt (md5) aller Tabellen vorher/nachher;
  - schickt je Eintrag eine ID aus dem eigenen Projekt „demo“ und erwartet den bisherigen Erfolgsstatus;
  - zwei Gegenproben (siehe unten).
- **Doku:** `docs/workflows.md` (Abschnitt „Mandanten-Prüfung für ID-Felder“) und Nachtrag in `docs/auftraege/agent-handoff-nur-eigenes-projekt-2026-10-25.md`.

### Gefundene Routen mit ID-Feld (Vollständigkeitsliste)

Ermittelt durch den Vollständigkeitstest aus allen registrierten Routen; die Liste entspricht `TENANT_ID_FIELDS` (31 Einträge).

| Datei | Methode, Pfad | Feld | Tabelle | Code |
|---|---|---|---|---|
| agent-tasks.ts | POST `/projects/:slug/agent-tasks` | agentId | agents | 400 |
| agent-tasks.ts | PATCH `/agent-tasks/:id` | agentId | agents | 400 |
| agents.ts | POST `/projects/:slug/agents` | handoffTo | agents | 400 |
| agents.ts | POST `/projects/:slug/agents/order` | ids | agents | 400 |
| agents.ts | PATCH `/agents/:id` | handoffTo | agents | 400 |
| worker.ts | GET `/projects/:slug/agents/:id/activity` | id (Pfad) | agents | 404 |
| worker.ts | POST `/projects/:slug/agents/:id/cancel` | id (Pfad) | agents | 404 |
| bugs.ts | POST `/projects/:slug/bugs` | sprintId | sprints | 400 |
| bugs.ts | PATCH `/bugs/:id` | sprintId | sprints | 400 |
| chat-routes.ts | POST `/projects/:slug/chat` | agentId | agents | 400 |
| chat-routes.ts | POST `/projects/:slug/chat` | replyTo | chat_messages | 400 |
| chat-routes.ts | POST `/projects/:slug/chat` | references | development_items u. a. | 400 |
| development.ts | POST `/projects/:slug/development` | ideationId | ideation_items | 400 |
| development.ts | POST `/projects/:slug/development` | testRunId | test_runs | 400 |
| development.ts | POST `/projects/:slug/development` | sprintId | sprints | 400 |
| development.ts | POST `/projects/:slug/development` | agentId | agents | 400 |
| development.ts | POST `/development/:id/follow-up` | sprintId | sprints | 400 |
| development.ts | POST `/development/:id/retry` | sprintId | sprints | 400 |
| development.ts | POST `/development/:id/take-into-sprint` | sprintId | sprints | 400 |
| development.ts | PATCH `/development/:id` | sprintId | sprints | 400 |
| development.ts | PATCH `/development/:id` | agentId | agents | 400 |
| test-runs.ts | GET `/projects/:slug/test-runs/:id/cases` | id (Pfad) | test_runs | 404 |
| test-requests.ts | POST `/projects/:slug/test-evidence/:id/run` | id (Pfad) | test_evidence | 404 |
| permission-groups.ts | PATCH `/projects/:slug/permission-groups/:id` | id (Pfad) | project_permission_groups | 404 |
| permission-groups.ts | DELETE `/projects/:slug/permission-groups/:id` | id (Pfad) | project_permission_groups | 404 |
| review-routes.ts | POST `/projects/:slug/review-slots/start` | developmentId | development_items | 404 |
| workflow.ts | POST `/projects/:slug/workflow/steps` | agentId | agents | 400 |
| workflow.ts | POST `/projects/:slug/workflow/order` | ids | workflow_steps | 400 |
| sprints.ts | POST `/sprints/:id/order` | ids | development_items | 400 |
| sprint-planning.ts | POST `/projects/:slug/sprints/proposal/apply` | ids | development_items | 400 |
| sprint-planning.ts | POST `/projects/:slug/sprints/proposal/comment` | ids | development_items | 400 |

Ausgenommen (`TENANT_ID_EXEMPT`, kein Datensatz eines Projekts oder projektübergreifend gefiltert): `role` in
`PUT /projects/:slug/budget/roles/:role`, `slot` in `POST /review-slots/:slot/stop`, `provider` in
`POST /agent-limits/:provider/resume`, `ids` in `POST /ideation/bulk/reject` und `POST /ideation/bulk/priority`
(das UPDATE filtert nach `allowedProjects`).

### Testlauf (31.10.2026, Arbeitscontainer mit PostgreSQL)

- `npm run typecheck`: ohne Fehler.
- `npm run lint`: 0 Fehler (nur bestehende Warnungen). `npm run format:check`: nach `npm run format` sauber.
- `npm run test:unit` (ganze Suite, die Datenbank-Tests liefen und wurden nicht übersprungen): 2102 Tests, 2091 bestanden, 10 übersprungen (Docker-Sandbox, macOS/Windows), **1 fehlgeschlagen**: `src/core/git-guard.test.ts` („Filter aus .git/config …“). Das liegt an der Umgebung: `/workspace/.git` verweist hier auf kein gültiges Repository („gitfile does not point to a valid repository“). Der Test hat keinen Bezug zu diesem Auftrag.
- Grün darin unter anderem: `agents.test.ts`, `agent-tasks.test.ts`, `app.test.ts`, `access.test.ts`, `tenancy.test.ts` und aus `tenant-ids.test.ts`:
  - „Jede registrierte Route mit ID-Feld steht in der Allowlist“
  - „Allowlist: jeder Eintrag ist eine registrierte Route mit diesem ID-Feld“
  - „Gegenprobe Erkennung: eine neue Route mit ID-Feld ohne Eintrag lässt den Test scheitern“
  - „Mandanten-Prüfung auf PostgreSQL …“ mit 32 Untertests (31 Allowlist-Einträge, je fremde und eigene ID, plus Gegenprobe)

### Gegenprobe

- **Erkennung:** Der Test registriert drei zusätzliche Routen mit ID-Feld (Pfadparameter `:otherId`, Feldliste mit `agentId`, Body-Feld `sprintId`). `findIdFields` meldet genau diese drei als fehlend; der Vollständigkeitstest würde also scheitern.
- **Verhalten:** Eine Testroute ohne `assertInProject` übernimmt eine `agentId` aus „fremd“ und schreibt einen Workflow-Schritt. `refusedWithoutWrite` scheitert für sie mit „201 statt 400/404“. Der Test erwartet dieses Scheitern (`assert.rejects`) und ist grün.

## Sprint

- Auftrag 852db391: umgesetzt und im Arbeitscontainer getestet; Abnahme durch Tester/Reviewer steht aus.
- Keine Schemaänderung, keine Migration.

## Anfrage / TODO

- `src/core/git-guard.test.ts` scheitert im Arbeitscontainer, weil `/workspace/.git` auf kein gültiges Repository zeigt (Umgebung, nicht dieser Auftrag).
- Keine Abdeckungs-Flags (`--experimental-test-coverage`) verwenden; der Wächter blockiert sie. Tests mit `npm run test:unit` starten, nicht mit `npx`.

## Technische Dokumentation

- **Ablauf:** `routeGuard` (`access.ts`) prüft den Mandanten der Route selbst (`:slug` bzw. `:id`), für Administratoren gar nicht. Alle weiteren IDs aus Pfad oder Body prüft die Route mit `assertInProject` vor jedem Schreiben und jeder Folgeaktion (Git-Sync, Trigger, Folgeaufträge).
- **Fehlercodes:** Body-IDs 400, Pfad-IDs und `developmentId` 404. Bestehende Codes (z. B. 409 bei Statusschutz) bleiben.
- **Neue ID-Eingabe hinzufügen:** Route mit `assertInProject` absichern, Eintrag in `TENANT_ID_FIELDS` ergänzen, Szenario in `tenant-ids.test.ts` anlegen. Fehlt der Eintrag, scheitert der Vollständigkeitstest; fehlt das Szenario, scheitert der Datenbanktest.
- **Grenzen:** Query-Parameter werden nicht geprüft. Bereits gespeicherte fremde Verweise werden nicht bereinigt. Rollen und Rechte (`roles.ts`, `access.test.ts`) bleiben unverändert. Der Test erkennt ID-Felder an Mustern im Quelltext (`body.x`, `record.x`, Feldlisten mit `parseUuid`); neue Schreibweisen der ID-Übernahme im Review beachten.
