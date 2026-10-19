# Dev-Log-Datenbank

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

- `ideation_items.source` (TEXT, NOT NULL, Standard `human`): Herkunft der Idee, Wertebereich `human` | `visionary` | `routine` | `production` | `github`. Bestehende Ideen erhalten beim Start `human` (`ADD COLUMN IF NOT EXISTS … DEFAULT 'human'`). Vom Visionär angelegte Ideen haben `status='idea'`, `source='visionary'` und die Begründung („Stützt sich auf …“) in `agent_note`; dazu kommt ein Kommentar in `ideation_comments` mit Autor „Visionär“ und den Belegen. `routine`, `production` und `github` sind vorgesehen, werden aber noch nicht befüllt.
- `ideation_items.rejection_reason` (TEXT): Grund aus „Ablehnen mit Grund“ (`POST /api/ideation/:id/reject`, setzt `status='rejected'`, zusätzlich als Kommentar). Der nächste Visionär-Lauf bekommt Titel und Grund aller abgelehnten Ideen im Prompt.
- `visionary_runs` (`id`, `project_slug` → `projects`, `status` requested/running/done/failed/cancelled, `progress`, `created_count`, `discarded_count`, `error`, `requested_by`, `requested_at`, `started_at`, `finished_at`): ein Lauf je Anfrage „Ideen vorschlagen lassen“. Ein eindeutiger Teilindex (`visionary_runs_open_idx`) erlaubt je Projekt höchstens einen angefragten oder laufenden Lauf.
- `app_settings.visionary_max_ideas`: höchstens so viele Ideen je Lauf (Standard 5, Maximum 8).
