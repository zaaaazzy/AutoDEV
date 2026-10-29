const parameter = (description: string, type = 'string'): { type: string; description: string } => ({
  type,
  description,
});

/**
 * Werkzeuge des lokalen Modells; run_command auch ohne Schreibrecht, wenn die Rolle Befehle ausführen darf.
 * canManageServices: Einrichtung durch den Assistenten (git clone/pull, npm install). canUseServices: Werkzeug
 * service_action für die Worker-Aktionen services.* (Recht „services“).
 */
export function toolDefinitions(
  canWrite: boolean,
  canManageServices = false,
  hasDatabase = false,
  canRunCommands = canWrite,
  canUseServices = false,
): unknown[] {
  const tools: { name: string; description: string; properties: Record<string, unknown>; required: string[] }[] = [
    {
      name: 'list_files',
      description: 'Listet Dateien und Ordner eines Verzeichnisses (Ordner enden mit /).',
      properties: { path: parameter('Relativer Pfad, "." für das Projektverzeichnis') },
      required: ['path'],
    },
    {
      name: 'read_file',
      description: 'Liest eine Textdatei (optional ab Zeile start_line, max. 300 Zeilen).',
      properties: {
        path: parameter('Relativer Dateipfad'),
        start_line: parameter('Erste Zeile (1-basiert)', 'integer'),
      },
      required: ['path'],
    },
    {
      name: 'search_text',
      description: 'Sucht einen Text (ohne Regex) in allen Textdateien unterhalb eines Pfads.',
      properties: { query: parameter('Suchtext'), path: parameter('Relativer Startpfad, Standard ".".') },
      required: ['query'],
    },
  ];
  if (canWrite) {
    tools.push(
      {
        name: 'write_file',
        description: 'Schreibt eine Datei vollständig (legt fehlende Ordner an, sichert das Original).',
        properties: { path: parameter('Relativer Dateipfad'), content: parameter('Vollständiger neuer Inhalt') },
        required: ['path', 'content'],
      },
      {
        name: 'replace_in_file',
        description: 'Ersetzt genau eine Textstelle in einer Datei.',
        properties: {
          path: parameter('Relativer Dateipfad'),
          old_text: parameter('Exakter bisheriger Text (muss genau einmal vorkommen)'),
          new_text: parameter('Neuer Text'),
        },
        required: ['path', 'old_text', 'new_text'],
      },
    );
  }
  if (canRunCommands) {
    tools.push(
      canWrite
        ? {
            name: 'run_command',
            description: `Führt erlaubte Projektbefehle aus (npm test/run/ls, git status/diff/log${canManageServices ? ', git clone/pull, npm install' : ''}). Kein docker – Dienste über service_action.`,
            properties: { command: parameter('z. B. "npm run build", "npm test" oder "git status"') },
            required: ['command'],
          }
        : {
            name: 'run_command',
            description:
              'Führt freigegebene Prüfbefehle aus (npm audit, npm outdated, git ls-files, git grep). Ändert nichts.',
            properties: { command: parameter('z. B. "npm audit --json", "npm outdated" oder "git grep -n TODO"') },
            required: ['command'],
          },
    );
  }
  if (canWrite) {
    if (hasDatabase) {
      tools.push({
        name: 'run_sql',
        description:
          'Führt SQL in der Datenbank dieses Projekts aus (lesen und schreiben, eine Transaktion, max. 50 ' +
          'Ergebniszeilen). Schema vorher mit information_schema prüfen. Keine Zugangsdaten raten oder erfinden.',
        properties: {
          sql: parameter('Eine SQL-Anweisung; UPDATE/DELETE nur mit WHERE und bis 500 Zeilen, ALTER TABLE nur ADD'),
        },
        required: ['sql'],
      });
    }
  }
  if (canUseServices) {
    tools.push({
      name: 'service_action',
      description:
        'Dienste des Projekts (Docker Compose im Projektordner) über den Worker verwalten: services.status, ' +
        'services.logs, services.restart, services.up und services.stop. Der Worker prüft die Anfrage und liefert ' +
        'das Ergebnis samt Ausgabe.',
      properties: {
        action: parameter('services.status, services.logs, services.restart, services.up oder services.stop'),
        services: parameter('Dienstnamen, durch Leerzeichen getrennt; leer = alle Dienste'),
        lines: parameter('Nur services.logs: letzte Zeilen (1–1000, Standard 200)', 'integer'),
        since: parameter('Nur services.logs: Zeitraum wie "15m" oder "2h" (höchstens 24h)'),
        build: parameter('Nur services.up: Images vorher bauen', 'boolean'),
        file: parameter('Compose-Datei relativ zum Projektordner; Standard: compose.yaml/docker-compose.yml'),
      },
      required: ['action'],
    });
  }
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: { type: 'object', properties: tool.properties, required: tool.required },
    },
  }));
}

export function systemPrompt(
  role: string,
  canWrite: boolean,
  hasDatabase = false,
  canRunCommands = canWrite,
  canUseServices = false,
): string {
  return [
    role === 'assistant'
      ? 'Du bist der Dashboard-Assistent und Problemlöser. Du darfst Probleme im Projekt selbst untersuchen ' +
        'und gezielt beheben.'
      : `Du bist ein autonomer Software-Agent mit der Rolle "${role}" und arbeitest im Projektverzeichnis.`,
    'Erkunde das Projekt zuerst mit den Werkzeugen, bevor du Aussagen machst oder Code schreibst. ' +
      'Erfinde keine Dateien oder Ergebnisse.',
    role === 'assistant'
      ? 'Du darfst Dateien mit write_file/replace_in_file ändern und sichere Projektbefehle ausführen. Alle ' +
        'Dateioperationen bleiben auf das Projektverzeichnis begrenzt; .env, Schlüssel, node_modules und ' +
        '.git sind gesperrt. Führe bei Problemen zuerst Diagnose und dann eine gezielte, nachvollziehbare ' +
        'Behebung samt passenden Tests aus. Du darfst Umgebungen aufsetzen: Repository mit "git clone ' +
        '<https-URL> <Unterordner oder .>" ins Projektverzeichnis holen, Abhängigkeiten mit npm install ' +
        'installieren und Konfiguration (z. B. docker-compose.yml, README-Vorgaben) prüfen und anlegen. ' +
        'Befolge die Vorgaben des Nutzers Schritt für ' +
        'Schritt und melde jeden Schritt. Beantworte alle Anfragen direkt und delegiere nicht. Erstelle ' +
        'niemals Aufträge oder @@TASK-Zeilen.'
      : canWrite
        ? 'Du darfst Dateien mit write_file/replace_in_file ändern. Halte Änderungen klein, passe vorhandenen ' +
          'Stil an, schreibe Tests und installiere fehlende Abhängigkeiten mit run_command ("npm install"), ' +
          'prüfe mit run_command ("npm run build", "npm test"). Beende die Arbeit mit einer kurzen ' +
          'Zusammenfassung der Änderungen. Ist der Auftrag nachweislich bereits vollständig umgesetzt, beginne ' +
          'die Antwort mit "KEINE ÄNDERUNG NÖTIG:" und nenne die geprüften Dateien als Beleg.'
        : 'Du darfst nichts verändern. Gib dein Ergebnis als Text in Markdown aus (ohne Werkzeugaufruf als ' +
          'letzte Nachricht). Arbeite effizient: höchstens etwa 8 Werkzeugaufrufe, lies nur die wirklich ' +
          'relevanten Dateien (README, package.json, betroffene Module) und antworte dann.',
    canRunCommands && !canWrite
      ? 'Mit run_command führst du freigegebene Prüfbefehle aus (z. B. "npm audit --json", "npm outdated", ' +
        '"git ls-files", "git grep -n TODO") und meldest ihr tatsächliches Ergebnis.'
      : '',
    canUseServices
      ? 'Dienste verwaltest du nur mit service_action (services.status, services.logs mit lines/since, ' +
        'services.restart, services.up mit build, services.stop) – nie per Shell, docker und Dienst-Befehle des ' +
        'Betriebssystems sind gesperrt. Prüfe Logs mit services.logs und starte hängende Dienste mit services.restart neu.'
      : '',
    hasDatabase
      ? 'Du hast mit run_sql Zugriff auf die Datenbank dieses Projekts. Prüfe zuerst per SELECT, ob Daten vorhanden ' +
        'sind, ändere nur gezielt und überschreibe keine Daten, die du nicht kennst. Erfinde keine Passwörter, ' +
        'Benutzer oder Endpunkte.'
      : '',
    'Wiederhole dich nicht: Hast du etwas bereits festgestellt, handle oder beende mit einer Antwort.',
    'Antworte auf Deutsch.',
  ]
    .filter(Boolean)
    .join('\n');
}
