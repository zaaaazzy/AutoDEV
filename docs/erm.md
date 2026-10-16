# Dev-Log-Datenbank

Eigene Datenbank, getrennt von `mainty`: `projects` (slug) 1:n `test_runs` 1:n `test_run_steps`; `projects` 1:n `ideation_items` 1:n `ideation_attachments` (Bilder bis 5 MB als BYTEA; Aufträge erreichen sie über `ideation_id`, der Runner legt sie unter `.dev-log/attachments/<auftrag>/` im Projektordner ab und nennt sie im Prompt); `projects` 1:n `development_items`, optional verknüpft mit einer Idee, einem Testlauf und einem Sprint desselben Projekts. `ideation_items` und `development_items` tragen `effort_hours`, `token_estimate`, `benefit` und `cost` (0–10). `projects` 1:n `sprints` (1:n `development_items`) und `projects` 1:n `agents` (`phase` pre_task/while_task/after_task, `position` = Reihenfolge). Das Schema wird beim Start von Dienst bzw. Agent automatisch angelegt.


Ergänzung: `agents.command` (TEXT[], Befehl ohne Shell). `development_items` 1:n `agent_runs` (ein laufender Lauf pro Auftrag) 1:n `agent_run_steps` (Agent, Phase, Status, Exit-Code, Dauer, Ausgabe).

## Erweiterungen: Bugs, Dokumentation, Sprintberichte

- `bugs` (Projekt, Titel, Schwere, Status open/in_progress/fixed/wontfix, Quelle, Sprint, fix_notes) – 1:n zu `development_items.bug_id` (kind `bug`).
- `sprint_reports` (Sprint, implemented, missing, problems, notes) – 1:1 je Sprint.
- `docs` (Projekt, kind manual/sprint/order/repo, Titel, Inhalt).
- `development_items`: zusätzlich `kind`, `bug_id`, `completed_at`; Trigger synchronisieren den Bug-Status.
- `agents.role`: author, developer, tester, reviewer, documenter, bug_reviewer, manual_writer, user_manual_writer, custom.
- Git-Sicherung: `projects.git_remote` (HTTPS/SSH-URL ohne Zugangsdaten); `sprints.git_sync` (pending/running/done/failed), `git_message`, `git_commit`, `git_synced_at`. Ein Trigger setzt `git_sync='pending'`, sobald ein Sprint `completed` wird.
