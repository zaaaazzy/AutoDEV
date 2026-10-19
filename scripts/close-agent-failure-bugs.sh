#!/bin/bash
# Schließt Bug-Berichte, die nur ein Scheitern des Agents selbst beschreiben (Zeitlimit, Schleife, keine Änderung,
# Modell/Befehl nicht erreichbar), als „wontfix“ und stoppt die zugehörigen, noch offenen Bug-Aufträge.
set -euo pipefail
cd "$(dirname "$0")/.."
PATTERN='Zeitlimit erreicht|Schleife erkannt|wiederholt mit denselben Argumenten|Maximale Anzahl von [0-9]+ Schritten erreicht|Der Entwickler-Agent hat keine Dateien geändert|Ollama nicht erreichbar|Ollama antwortete mit [0-9]+|Ollama lieferte keine Nachricht|Das Modell lieferte keine Antwort|im PATH des Workers nicht gefunden|ENOENT|Process ended by SIG[A-Z]+ \(timeout or kill\)|Unterbrochen: Der Worker wurde beendet'
docker compose exec -T db psql -U "${DEV_LOG_DB_USER:-devlog}" -d aideation -v ON_ERROR_STOP=1 -v pattern="$PATTERN" <<'SQL'
BEGIN;
CREATE TEMP TABLE noise ON COMMIT DROP AS
  SELECT id FROM bugs
   WHERE source = 'agent' AND status IN ('open', 'in_progress') AND right(description, 1500) ~ :'pattern';
UPDATE development_items SET auto_run = FALSE, status = 'backlog', updated_at = NOW()
 WHERE kind = 'bug' AND bug_id IN (SELECT id FROM noise) AND status IN ('planned', 'blocked');
UPDATE development_items SET failure_bug_id = NULL WHERE failure_bug_id IN (SELECT id FROM noise);
UPDATE bugs SET status = 'wontfix', updated_at = NOW() WHERE id IN (SELECT id FROM noise);
SELECT count(*) AS "geschlossene Agent-Fehler-Bugs" FROM noise;
COMMIT;
SQL
