# Mandanten-Prüfung für alle ID-Felder per Allowlist-Test

Auftrag 852db391 (30.10.2026). Folgt auf den Vorfall in `docs/agent-handoff-nur-eigenes-projekt-2026-10-25.md`.

## Aufträge

### Was umgesetzt wurde

- **Gemeinsamer Helfer `assertInProject(pool, tabelle, id, projektSlug)`** in `src/api/tenancy.ts`. Er nimmt eine ID oder eine Liste von IDs und prüft über `project_slug`, ob alles zum Projekt gehört. Ohne ID (`null`, leere Liste) gibt es nichts zu prüfen (`true`). Tabellen kommen nur aus der festen Liste `PROJECT_TABLES`, nie aus Eingabe. Er nutzt den Projekt-Slug, nicht eine numerische ID.
- **`agentInProject` ist entfernt.** Die Aufrufe in `agent-tasks.ts` und `agents.ts` (`PATCH /agents/:id`, `handoffTo`) nutzen den neuen Helfer. Verhalten von `handoffTo` unverändert: fremde ID 400, `null` erlaubt.
- **Allowlist `src/api/tenant-id-fields.ts`** (`TENANT_ID_FIELDS`): je Eintrag Methode, Pfad, Ort (Pfad/Body), Feldname, Tabelle und erwarteter Ablehnungscode. `TENANT_ID_EXEMPT` führt Pfadparameter auf, die keine Datensätze sind (`role`, `slot`), mit Begründung.
- **Weitere Routen**, die nun mit `assertInProject` vor dem Schreiben prüfen: `development.ts`, `sprints.ts`, `workflow.ts`, `worker.ts`, `test-runs.ts` sowie Sprint-Vorschlag (`proposal/apply`, `proposal/comment`).
- **`review-routes.ts` unverändert**: `developmentId` bleibt bei 404, steht aber in der Allowlist.
- **Integrationstest `src/api/tenant-ids.test.ts`**:
  - liest die registrierten Express-Routen samt Quelltext und scheitert, wenn eine Route mit ID-Feld nicht in der Allowlist steht (und umgekehrt, wenn ein Eintrag keine Route ist);
  - schickt je Eintrag eine gültige ID aus dem Projekt „fremd“, erwartet 400/404 und vergleicht Zeilenzahl und Inhalt der Tabellen vorher/nachher;
  - schickt je Eintrag eine ID aus dem eigenen Projekt und erwartet den bisherigen Erfolgsstatus;
  - **Gegenprobe** im Test: eine Testroute ohne `assertInProject` übernimmt die fremde ID, der Test für sie schlägt wie erwartet fehl.
- Anpassungen in bestehenden Tests (`agents.test.ts`, `app.test.ts`, `development-retry.test.ts`, `development-status.test.ts`, `sprint-complete.test.ts`, `test-runs.test.ts`) an den neuen Helfer bzw. die Attrappen.
- **Doku:** `docs/workflows.md` (Abschnitt „Mandanten-Prüfung für ID-Felder“) und Nachtrag im Handoff-Dokument.

### Geänderte Dateien

`src/api/tenancy.ts`, `src/api/tenant-id-fields.ts`, `src/api/tenant-ids.test.ts`, `src/api/agent-tasks.ts`, `src/api/agents.ts`, `src/api/agents.test.ts`, `src/api/development.ts`, `src/api/development-retry.test.ts`, `src/api/development-status.test.ts`, `src/api/sprint-complete.test.ts`, `src/api/sprints.ts`, `src/api/workflow.ts`, `src/api/worker.ts`, `src/api/test-runs.ts`, `src/api/test-runs.test.ts`, `src/api/app.test.ts`, `docs/workflows.md`, `docs/agent-handoff-nur-eigenes-projekt-2026-10-25.md`.

### Gefundene Routen mit ID-Feld (Vollständigkeitsliste)

| Datei | Methode, Pfad | Feld | Tabelle | Code |
|---|---|---|---|---|
| agent-tasks.ts | POST `/projects/:slug/agent-tasks` | agentId | agents | 400 |
| agent-tasks.ts | PATCH `/agent-tasks/:id` | agentId | agents | 400 |
| agents.ts | POST `/projects/:slug/agents` | handoffTo | agents | 400 |
| agents.ts | POST `/projects/:slug/agents/order` | ids | agents | 400 |
| agents.ts | PATCH `/agents/:id` | handoffTo | agents | 400 |
| worker.ts | GET `…/agents/:id/activity`, POST `…/agents/:id/cancel` | id (Pfad) | agents | 404 |
| bugs.ts | POST `/projects/:slug/bugs`, PATCH `/bugs/:id` | sprintId | sprints | 400 |
| chat-routes.ts | POST `/projects/:slug/chat` | agentId / replyTo / references | agents / chat_messages / development_items | 400 |
| development.ts | POST `/projects/:slug/development` | ideationId, testRunId, sprintId, agentId | je Tabelle | 400 |
| development.ts | POST `follow-up`, `retry`, `take-into-sprint`; PATCH `/development/:id` | sprintId (PATCH auch agentId) | sprints / agents | 400 |
| test-runs.ts | GET `…/test-runs/:id/cases` | id (Pfad) | test_runs | 404 |
| permission-groups.ts | PATCH/DELETE `…/permission-groups/:id` | id (Pfad) | project_permission_groups | 404 |
| review-routes.ts | POST `…/review-slots/start` | developmentId | development_items | 404 |
| workflow.ts | POST `…/workflow/steps`, `…/workflow/order` | agentId, ids | agents, workflow_steps | 400 |
| sprints.ts | POST `/sprints/:id/order` | ids | development_items | 400 |
| sprint-planning.ts | POST `…/sprints/proposal/apply`, `…/comment` | ids | development_items | 400 |

Ausgenommen (kein Datensatz): `role` in `PUT …/budget/roles/:role`, `slot` in `POST /review-slots/:slot/stop`.

## Sprint

- Auftrag 852db391: umgesetzt, Entwickler-Schritt bestanden, Abnahme durch Tester/Reviewer steht aus.
- Keine Schemaänderung, keine Migration.

## Anfrage / TODO

- **Nicht belegt:** Der Entwickler konnte in seiner Umgebung weder `npm run typecheck` noch Tests ausführen (kein `tsx`/`tsc`, `node_modules` zeigt auf einen Host-Pfad). Die Akzeptanzkriterien „typecheck fehlerfrei“ und „Testlauf zusammen mit `agents.test.ts` und `agent-tasks.test.ts` grün“ sind daher noch offen.
- Der Tester soll `npm run typecheck` und `npm run test:unit` mit `DEV_LOG_TEST_REQUIRE_DATABASE=1` und PostgreSQL ausführen, damit `tenant-ids.test.ts` nicht übersprungen wird. Besonders prüfen: die beiden Vollständigkeits-Tests und die Szenarien für `sprints/proposal/apply` und `…/comment`.
- Keine Abdeckungs-Flags (`--experimental-test-coverage`) verwenden; der Wächter blockiert sie.

## Technische Dokumentation

- **Ablauf:** `routeGuard` (`access.ts`) prüft den Mandanten der Route selbst (`:slug` bzw. `:id`), für Administratoren gar nicht. Alle weiteren IDs aus Pfad oder Body prüft die Route mit `assertInProject` vor jedem Schreiben und jeder Folgeaktion (Git-Sync, Trigger, Folgeaufträge).
- **Fehlercodes:** Body-IDs 400, Pfad-IDs und `developmentId` 404. Bestehende Codes (z. B. 409 bei Statusschutz) bleiben.
- **Neue ID-Eingabe hinzufügen:** Route mit `assertInProject` absichern, Eintrag in `TENANT_ID_FIELDS` ergänzen, Szenario in `tenant-ids.test.ts` anlegen. Fehlt der Eintrag, scheitert der Vollständigkeitstest.
- **Grenzen:** Query-Parameter werden nicht geprüft. Bereits gespeicherte fremde Verweise werden nicht bereinigt. Rollen und Rechte (`roles.ts`, `access.test.ts`) bleiben unverändert. Der Test ist nur so gut wie seine Erkennung von ID-Feldern im Quelltext; neue Schreibweisen der ID-Übernahme im Review beachten.
