// Frühere, gespeicherte Rechte-Regeln, die beim Laden ersetzt werden (normalizeCommands bzw. normalizeGroups in
// permission-rules.ts).

/**
 * Frühere Dienst-Regeln: launchctl kickstart bzw. list (jede Benutzer-ID, jeder Dienstname) und die
 * Docker-Verwaltung der Agents (docker compose …, docker ps/logs). Sie gehen in der Gruppe „services“ auf.
 */
export const LEGACY_SERVICE_RULE =
  /^Bash\((?:launchctl (?:kickstart|list)\b[^)]*|docker compose (?:ps|config --services|logs|up|stop|start|restart|down|build|pull)(?::\*)?|docker (?:ps|logs)(?::\*)?)\)$/;

/** Frühere Gruppe „Docker-Dienste“; ihr Platz ist jetzt die Gruppe „services“. */
export const LEGACY_DOCKER_GROUP = 'docker';
