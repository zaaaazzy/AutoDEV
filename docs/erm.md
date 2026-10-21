# AIdeation-Datenbank

Eigene Datenbank, getrennt von `mainty`: `projects` (slug) 1:n `test_runs` 1:n `test_run_steps`; `projects` 1:n `ideation_items` 1:n `ideation_attachments` (Bilder bis 5 MB als BYTEA; Aufträge erreichen sie über `ideation_id`, der Runner legt sie unter `.dev-log/attachments/<auftrag>/` im Projektordner ab und nennt sie im Prompt); `projects` 1:n `development_items`, optional verknüpft mit einer Idee, einem Testlauf und einem Sprint desselben Projekts. `ideation_items` und `development_items` tragen `effort_hours`, `token_estimate`, `benefit` und `cost` (0–10). `projects` 1:n `sprints` (1:n `development_items`) und `projects` 1:n `agents` (`phase` pre_task/while_task/after_task, `position` = Reihenfolge). Das Schema wird beim Start von Dienst bzw. Agent automatisch angelegt.

Ergänzung: `agents.command` (TEXT[], Befehl ohne Shell). `development_items` 1:n `agent_runs` (ein laufender Lauf pro Auftrag) 1:n `agent_run_steps` (Agent, Phase, Status, Exit-Code, Dauer, Ausgabe).

## Erweiterungen: Bugs, Dokumentation, Sprintberichte

- `bugs` (Projekt, Titel, Schwere, Status open/in_progress/fixed/wontfix, Quelle, Sprint, fix_notes) – 1:n zu `development_items.bug_id` (kind `bug`).
- `sprint_reports` (Sprint, implemented, missing, problems, notes) – 1:1 je Sprint.
- `docs` (Projekt, kind manual/sprint/order/repo, Titel, Inhalt).
- `development_items`: zusätzlich `kind`, `bug_id`, `completed_at`; Trigger synchronisieren den Bug-Status.
- `agents.role`: author, developer, tester, reviewer, documenter, bug_reviewer, manual_writer, user_manual_writer, custom.
- Git-Sicherung: `projects.git_remote` (HTTPS/SSH-URL ohne Zugangsdaten); `projects.database_url` (optional, Zugang zur Projekt-Datenbank für `run_sql`); `sprints.git_sync` (pending/running/done/failed), `git_action` (push/pull), `git_message`, `git_commit`, `git_synced_at`. Ein Trigger setzt `git_sync='pending'`, sobald ein Sprint `completed` wird (nicht beim Übergang `review` → `completed`).
- GitHub-Brücke: `projects.github_mode` (aus/issues/issues+pr), `github_require_approval`, `github_synced_at`, `github_auth` (ok/missing) mit `github_auth_message` und `github_auth_checked_at`; `sprints.status` zusätzlich `review`, dazu `pr_url`, `ci_status` (pending/success/failure) und `ci_bug_run`; `ideation_items` und `bugs` mit `source='github'`, `external_ref` (`owner/repo#N`, eindeutig je Projekt) und `github_synced_status`; `development_items.git_commit`.

## Erweiterung: Visionär (Ideen-Herkunft und Läufe)

- `ideation_items.source` (TEXT, NOT NULL, Standard `human`): Herkunft der Idee, Wertebereich `human` | `visionary` | `routine` | `production` | `github`. Bestehende Ideen erhalten beim Start `human` (`ADD COLUMN IF NOT EXISTS … DEFAULT 'human'`). Vom Visionär angelegte Ideen haben `status='idea'`, `source='visionary'` und die Begründung („Stützt sich auf …“) in `agent_note`; dazu kommt ein Kommentar in `ideation_comments` mit Autor „Visionär“ und den Belegen. `routine` (Marker `@@IDEA` einer Routine, mit `routine_run_id`), `production` und `github` sind vorgesehen; `routine` wird befüllt.
- `ideation_items.rejection_reason` (TEXT): Grund aus „Ablehnen mit Grund“ (`POST /api/ideation/:id/reject`, setzt `status='rejected'`, zusätzlich als Kommentar). Der nächste Visionär-Lauf bekommt Titel und Grund aller abgelehnten Ideen im Prompt.
- `visionary_runs` (`id`, `project_slug` → `projects`, `status` requested/running/done/failed/cancelled, `progress`, `created_count`, `discarded_count`, `error`, `requested_by`, `requested_at`, `started_at`, `finished_at`): ein Lauf je Anfrage „Ideen vorschlagen lassen“. Ein eindeutiger Teilindex (`visionary_runs_open_idx`) erlaubt je Projekt höchstens einen angefragten oder laufenden Lauf.
- `app_settings.visionary_max_ideas`: höchstens so viele Ideen je Lauf (Standard 5, Maximum 8).

## Erweiterung: Produktions-Rückkanal (Fehler aus dem Betrieb)

- `projects`: `health_url` (nur http(s) auf localhost, LAN oder eigener Domain), `log_services` (TEXT[], Compose-Dienste für den Log-Scan), `ingest_token_hash` (SHA-256 des Ingest-Tokens; der Klartext wird nie gespeichert), `production_ignore` (TEXT[], Ausschlussmuster), `production_retention_days` (1–365, Standard 30).
- Zeitgesteuerte Routinen: `agent_tasks` zusätzlich `schedule` (Cron, 5 Felder, optional), `enabled`, `next_run_at` (TIMESTAMPTZ, in Europe/Zurich berechnet), `output_target` (`chat` | `push` | `bug` | `idea` | `order`), `run_window`, `last_status`, `last_error`, `failure_streak`, `template`; der Trigger `agent_tasks_clear_next_run` (PostgreSQL 14+) löscht `next_run_at` ohne Zeitplan oder bei Pause. `agent_task_runs` (`task_id` → `agent_tasks`, `trigger` schedule/manual, `status` queued/running/ok/failed/cancelled, `environment_error`, `message_id`/`answer_id` → `chat_messages`, Start, Ende, `duration_ms`, `tokens`) – n:1 zu `agent_tasks`. `bugs`, `ideation_items` und `development_items` haben `routine_run_id` → `agent_task_runs` (`ON DELETE SET NULL`).
- `bugs.source` zusätzlich `production` (Quelle „Betrieb“); `bugs.regressed_at`: Zeitpunkt, zu dem ein behobener Betriebs-Bug wieder auftrat und als Regression geöffnet wurde.
- `production_events` (`project_slug`, `fingerprint` – eindeutig je Projekt, `source` health/logs/ingest, `origin` Dienst bzw. Pfad, `first_seen`, `last_seen`, `count`, `sample` maskiert und auf 2000 Zeichen gekürzt, `bug_id` → `bugs`, `deploy_suspect` JSONB mit Deploy-Zeitpunkt, Aufträgen und Sprints) – n:1 zu `bugs`.
- `production_event_buckets` (`event_id`, `hour`, `count`): Verlauf je Stunde für „seit gestern“, die Schwere (≥ 50/h = kritisch) und das Diagramm im Bug-Detail.
- `production_deploys` (`project_slug`, `deployed_at`, `order_ids` UUID[]): erfolgreiche Deploys mit den seit dem vorigen Deploy erledigten Aufträgen; Grundlage des Deploy-Verdachts (30 min).
- `production_status` (je Projekt): Health-Fehlschläge in Folge, `down`, letzter Fehler, Zeitpunkt der Prüfung bzw. des letzten erfolgreichen Log-Scans (`logs_scanned_at`, untere Grenze des nächsten Scan-Fensters), letzter Scan-Fehler (`log_error`, höchstens 300 Zeichen, beim nächsten Erfolg leer), zuletzt vermerkte Lücke (`log_gap`) und – wie beim Wächter – gemeldete Probleme (`problems`, `notified_at`).
- Aufbewahrung: Der Worker löscht stündlich Ereignisse, Verlauf und Deploys, die älter als `production_retention_days` sind.

## Erweiterung: Visuelle Abnahme (Screenshots vor und nach dem Auftrag)

- `projects`: `preview_url` (http(s), ohne Zugangsdaten; leer = Schritt übersprungen), `preview_pages` (JSONB-Liste von Pfaden wie `/#dashboard`), `visual_settings` (JSONB: `tolerance` in Prozent, `threshold` Farbabstand, `masks` CSS-Selektoren, `login` mit Seite, Selektoren und den **Namen** der Testwerte aus der `.env.example`, `aiJudge`, `visionModel`).
- `agents.role` zusätzlich `visual_tester`; `acceptance_checks.kind` zusätzlich `visual` (Befunde der visuellen Prüfung, ersetzt bei jedem Lauf; der Tester lässt sie stehen).
- `development_items`: `visual_approved_at`, `visual_approved_by` (Anzeigename) – „Optisch freigeben“ im Reiter „Ansicht“.
- `visual_snapshots` (`id` UUID, `development_id` → `development_items`, `project_slug` → `projects` (Mandant), `page`, `device` desktop/mobile, `kind` shot/diff, `data` PNG als BYTEA höchstens 2 MB, `diff_percent`, `base_id` → Vorher-Stand, `created_at`). Je Projekt, Seite, Gerät und Art bleiben die letzten 3 Stände; ältere löscht der Schritt beim Speichern. Auslieferung über `/api/visual-snapshots/<id>` mit Mandantenprüfung (`tenancy.ts`).

## Erweiterung: Wartungs-Jobs im Worker

- `scheduled_jobs` (eigenständig, ohne Fremdschlüssel): `key` (PK, `[a-z0-9_-]`, max. 64), `enabled`, `start_at`, `interval_seconds` (60 s bis 30 Tage), `job_kind` (Schlüssel der festen Registry in `src/runner/scheduler.ts`: `backup_check`, `watchdog_logs`, `close_old_sprints`, `push_alert`; anderes wird nicht ausgeführt, sondern mit `failed` gespeichert), `config` (JSONB-Objekt, je Art z. B. `dir`, `maxAgeHours`, `minBytes`, `inactiveDays`, `project`, `jobs`, `timeoutSeconds`), `next_run_at`, `last_run_at`, `last_status` (running/ok/warning/failed), `last_message`, `state` (JSONB, bereits gemeldete Probleme und Zeitpunkt wie beim Wächter), `locked_until` (Sperre eines beanspruchten Laufs gegen andere Worker; nach Zeitlimit + 30 s frei), `updated_at`.
- Die vier Standardjobs legt das Schema über `ON CONFLICT (key) DO NOTHING` an. `close_old_sprints` ist aus, weil er den Sprint-Status ändert. Ändert ein Administrator Intervall oder Startzeit (`PATCH /api/scheduled-jobs/<key>`), wird `next_run_at` ab dem letzten Lauf neu berechnet, frühestens ab der Startzeit.
