// Rechte-Regeln: Pseudo-Befehle, Datei-Werkzeuge, eingebaute Rechte-Gruppen und Rollen-Sets.

/** Eine schaltbare Rechte-Gruppe für Dashboard-Assistent und Entwickler (Claude-CLI-Regeln). */
export interface PermissionGroup {
  id: string;
  label: string;
  description: string;
  rules: string[];
}

const prefixRules = (prefixes: string[]): string[] => prefixes.map((prefix) => `Bash(${prefix}:*)`);

/** Datei-Werkzeuge der Claude-CLI: Write legt an (oder überschreibt), die übrigen ändern bestehende Dateien. */
export const CREATE_TOOLS = ['Write'];
export const EDIT_TOOLS = ['Edit', 'NotebookEdit'];
export const FILE_TOOLS = [...CREATE_TOOLS, ...EDIT_TOOLS];
/** Befehle ohne Claude-Regel: Dateien anlegen bzw. ändern (Datei-Werkzeuge, vom Wächter geprüft) und Dienst-Logs lesen. */
export const FILES_CREATE = 'files:create';
export const FILES_EDIT = 'files:edit';
/** Frühere Sammelregel „Dateien erstellen und ändern“; wird beim Laden in beide Rechte aufgeteilt. */
export const LEGACY_FILES_COMMAND = 'files';
export const LOGS_COMMAND = 'logs';
/** SQL auf der Projekt-Datenbank – nur das lokale Modell hat dafür ein Werkzeug (run_sql). */
export const DATABASE_COMMAND = 'database';
/** Live-Dienste der Projekte neu starten; wird erst beim Start mit der Benutzer-ID des Workers aufgelöst. */
export const SERVICES_COMMAND = 'services';
export const servicesRule = (): string => `Bash(launchctl kickstart -k gui/${process.getuid?.() ?? 501}/ch.*)`;
const PSEUDO_COMMANDS = new Set([FILES_CREATE, FILES_EDIT, LOGS_COMMAND, DATABASE_COMMAND, SERVICES_COMMAND]);

/** Ob eine Freigabe („Bash(befehl:*)“ bzw. „Bash(befehl)“) einen Shell-Befehl abdeckt (für das lokale Modell). */
export function rulesAllow(rules: readonly string[], command: string): boolean {
  return rules.some((rule) => {
    const bash = rule.match(/^Bash\((.+?)(:\*)?\)$/);
    if (!bash) return false;
    const prefix = bash[1]!;
    return bash[2] ? command === prefix || command.startsWith(`${prefix} `) : command === prefix;
  });
}
export const isToolRule = (rule: string): boolean => !PSEUDO_COMMANDS.has(rule) && rule !== LEGACY_FILES_COMMAND;

/** Ersetzt frühere Regeln: „files“ durch Anlegen und Ändern, launchctl mit fester Benutzer-ID durch „services“. */
export function normalizeCommands(rules: readonly string[]): string[] {
  return [
    ...new Set(
      rules.flatMap((rule) =>
        rule === LEGACY_FILES_COMMAND
          ? [FILES_CREATE, FILES_EDIT]
          : /^Bash\(launchctl kickstart -k gui\/\d+\/ch\.\*\)$/.test(rule)
            ? [SERVICES_COMMAND]
            : [rule],
      ),
    ),
  ];
}

/** Lesbare Bezeichnung eines Befehls für die Oberfläche (ohne Platzhalter für weitere Argumente). */
export function commandLabel(rule: string): string {
  if (rule === FILES_CREATE) return 'Dateien anlegen';
  if (rule === FILES_EDIT) return 'Dateien ändern';
  if (rule === LOGS_COMMAND) return '~/Library/Logs lesen';
  if (rule === DATABASE_COMMAND) return 'SQL auf der Projekt-Datenbank';
  if (rule === SERVICES_COMMAND) return 'launchctl kickstart -k ch.*';
  const bash = rule.match(/^Bash\((.+?)(?::\*)?\)$/);
  if (bash) return bash[1]!.replace(/ gui\/\d+\//, ' ');
  const web = rule.match(/^WebFetch\(domain:(.+)\)$/);
  return web ? `Webseiten auf ${web[1]} abrufen` : rule;
}

/** Erklärung je Befehl (Hover in der Oberfläche). */
const COMMAND_HELP: Record<string, string> = {
  [FILES_CREATE]:
    'Neue Dateien im Projektordner (bzw. in den erlaubten Ordnern) anlegen. Bestehende Dateien überschreiben braucht zusätzlich „Dateien ändern“.',
  [FILES_EDIT]: 'Bestehende Dateien im Projektordner (bzw. in den erlaubten Ordnern) bearbeiten oder überschreiben.',
  [SERVICES_COMMAND]:
    'Startet Live-Dienste der Projekte (launchd, ch.*) neu – nicht AIdeation selbst (com.aideation.*).',
  [DATABASE_COMMAND]:
    'Liest und ändert die Projekt-Datenbank per SQL (Werkzeug run_sql des lokalen Modells; braucht eine hinterlegte Datenbank-URL).',
  [LOGS_COMMAND]: 'Liest Dienst-Logs unter ~/Library/Logs, z. B. das Log des Live-Modus (nur lesen).',
  'Bash(lsof -i:*)': 'Zeigt, welche Prozesse welche Netzwerk-Ports belegen.',
  'Bash(ps:*)': 'Listet laufende Prozesse (nur lesen).',
  'Bash(netstat:*)': 'Zeigt offene Netzwerkverbindungen und Ports (nur lesen).',
  'Bash(node --version:*)': 'Zeigt die installierte Node.js-Version.',
  'Bash(launchctl list:*)': 'Listet die launchd-Dienste und ihren Status (nur lesen).',
  'WebFetch(domain:localhost)':
    'Ruft lokale Seiten und APIs auf localhost ab, z. B. um den laufenden Dienst zu prüfen.',
  'WebFetch(domain:127.0.0.1)': 'Ruft lokale Seiten und APIs auf 127.0.0.1 ab.',
  'Bash(npm test:*)': 'Führt die Tests des Projekts aus (Skript „test“ aus package.json).',
  'Bash(npm run:*)':
    'Führt ein Skript aus package.json aus, z. B. build oder lint. Achtung: Skripte können beliebige Befehle enthalten.',
  'Bash(npx --no-install ng:*)': 'Angular-CLI (ng build, ng test …) – nur die im Projekt installierte Version.',
  'Bash(npx --no-install tsc:*)': 'TypeScript-Prüfung bzw. -Übersetzung – nur die im Projekt installierte Version.',
  'Bash(npx --no-install vitest:*)': 'Vitest-Tests – nur die im Projekt installierte Version.',
  'Bash(npx --no-install playwright:*)': 'Playwright-Oberflächentests – nur die im Projekt installierte Version.',
  'Bash(node --check:*)': 'Prüft eine JavaScript-Datei nur auf Syntaxfehler, führt nichts aus.',
  'Bash(npm install --ignore-scripts:*)':
    'Installiert Abhängigkeiten aus package.json bzw. neue Pakete – ohne Installationsskripte.',
  'Bash(npm ci --ignore-scripts:*)':
    'Installiert exakt die Versionen aus package-lock.json – ohne Installationsskripte.',
  'Bash(git status:*)': 'Zeigt geänderte und neue Dateien im Repository.',
  'Bash(git diff:*)': 'Zeigt Änderungen zeilengenau (ohne --output, also ohne Dateien zu schreiben).',
  'Bash(git log:*)': 'Zeigt die Commit-Historie.',
  'Bash(git fetch:*)': 'Holt neue Commits vom Remote, ohne lokale Dateien zu ändern.',
  'Bash(git pull --ff-only:*)': 'Holt und übernimmt neue Commits, nur wenn kein Merge nötig ist.',
  'Bash(git checkout:*)':
    'Wechselt den Branch oder stellt Dateien aus Git wieder her (verwirft dort lokale Änderungen).',
  'Bash(docker compose ps:*)': 'Zeigt die Docker-Dienste des Projekts und ihren Status.',
  'Bash(docker compose config --services:*)': 'Listet die Namen der Docker-Dienste des Projekts.',
  'Bash(docker compose logs:*)': 'Zeigt die Logs der Docker-Dienste des Projekts.',
  'Bash(docker compose up:*)':
    'Startet die Docker-Dienste des Projekts. Vorher geprüft: nur Mounts und Builds im Projektordner, nicht privilegiert.',
  'Bash(docker compose stop:*)': 'Hält Docker-Dienste des Projekts an.',
  'Bash(docker compose start:*)': 'Startet angehaltene Docker-Dienste des Projekts (mit Compose-Prüfung).',
  'Bash(docker compose restart:*)': 'Startet Docker-Dienste des Projekts neu (mit Compose-Prüfung).',
  'Bash(docker compose down:*)': 'Stoppt und entfernt die Container des Projekts (Volumes bleiben erhalten).',
  'Bash(docker compose build:*)': 'Baut die Images der Docker-Dienste neu (mit Compose-Prüfung).',
  'Bash(docker compose pull:*)': 'Lädt neue Versionen der verwendeten Images.',
  'Bash(docker ps:*)': 'Listet alle laufenden Container (nur lesen).',
  'Bash(docker logs:*)': 'Zeigt die Logs eines Containers (nur lesen).',
};

/** Erklärung eines Befehls; für eigene Befehle eine allgemeine Beschreibung. */
export function commandHelp(rule: string): string {
  const known = COMMAND_HELP[rule];
  if (known) return known;
  const bash = rule.match(/^Bash\((.+?)(:\*)?\)$/);
  if (bash) return bash[2] ? `Führt „${bash[1]}“ aus, auch mit weiteren Argumenten.` : `Führt genau „${bash[1]}“ aus.`;
  return rule;
}

export const PERMISSION_GROUPS: PermissionGroup[] = [
  {
    id: 'files',
    label: 'Dateien',
    description:
      'Dateien anlegen bzw. ändern, wahlweise nur in bestimmten Ordnern. Lesen und Durchsuchen ist immer erlaubt.',
    rules: [FILES_CREATE, FILES_EDIT],
  },
  {
    id: 'diagnose',
    label: 'Diagnose',
    description:
      'Prozesse und Ports prüfen (ps, lsof, netstat), lokale URLs abrufen (WebFetch auf localhost). Dateien liest der Agent mit seinem Lese-Werkzeug, nicht per Shell.',
    rules: [
      ...prefixRules(['lsof -i', 'ps', 'netstat', 'node --version', 'launchctl list']),
      // Kein curl/cat/tail: Mit Shell-Lesebefehlen ließen sich Dateien außerhalb des Projekts lesen und per curl verschicken.
      'WebFetch(domain:localhost)',
      'WebFetch(domain:127.0.0.1)',
    ],
  },
  {
    id: 'logs',
    label: 'Dienst-Logs lesen',
    description: 'Zugriff auf ~/Library/Logs, z. B. das Log des Live-Modus.',
    rules: [LOGS_COMMAND],
  },
  {
    id: 'database',
    label: 'Projekt-Datenbank',
    description: 'SQL auf der Datenbank des Projekts (nur lokales Modell, sofern eine Datenbank-URL hinterlegt ist).',
    rules: [DATABASE_COMMAND],
  },
  {
    id: 'build',
    label: 'Build und Tests',
    description: 'npm-Skripte, Angular-, TypeScript- und Test-Werkzeuge ausführen.',
    rules: prefixRules([
      // Unterordner per „npm run --prefix <ordner> <skript>“. Kein „npm --prefix“: das erlaubte auch „npm --prefix . exec“.
      'npm test',
      'npm run',
      // Nur installierte Werkzeuge: „npx tsc“ lädt sonst das fremde npm-Paket „tsc“, „npx ng“ das Paket „ng“.
      // Kein „npx tsx“: startet beliebige Skripte.
      'npx --no-install ng',
      'npx --no-install tsc',
      'npx --no-install vitest',
      'npx --no-install playwright',
      // Nur Syntaxprüfung, führt nichts aus.
      'node --check',
    ]),
  },
  {
    id: 'install',
    label: 'Pakete installieren',
    description:
      'Abhängigkeiten mit npm install bzw. npm ci installieren – immer mit --ignore-scripts (keine Installationsskripte).',
    rules: prefixRules(['npm install --ignore-scripts', 'npm ci --ignore-scripts']),
  },
  {
    id: 'git',
    label: 'Git lesen und aktualisieren',
    // Kein „git clone“: mit -u/--upload-pack führt es beliebige Befehle aus und schreibt ausserhalb des Projekts.
    // Kein „git checkout“: Branch und Commits eines Auftrags verwaltet AIdeation; ein Checkout würde dem laufenden
    // Auftrag den Branch wechseln oder seine offenen Änderungen verwerfen.
    description: 'status, diff, log, fetch, pull --ff-only – kein Checkout, kein Push, kein Clone.',
    rules: prefixRules(['git status', 'git diff', 'git log', 'git fetch', 'git pull --ff-only']),
  },
  {
    id: 'docker',
    label: 'Docker-Dienste',
    description: 'docker compose ps/logs/up/stop/start/restart/down/build/pull, docker ps und docker logs.',
    rules: prefixRules([
      'docker compose ps',
      'docker compose config --services',
      'docker compose logs',
      'docker compose up',
      'docker compose stop',
      'docker compose start',
      'docker compose restart',
      'docker compose down',
      'docker compose build',
      'docker compose pull',
      'docker ps',
      'docker logs',
    ]),
  },
  {
    id: 'services',
    label: 'Projekt-Dienste neu starten',
    description: 'Live-Dienste der Projekte (ch.*) per launchctl neu starten – nicht AIdeation selbst.',
    // Beim Start: Bash(launchctl kickstart -k gui/<uid>/ch.*) – Wildcard statt Präfix, weil „:*“ nur an Wortgrenzen greift.
    rules: [SERVICES_COMMAND],
  },
];

export const DEFAULT_PERMISSION_GROUPS = PERMISSION_GROUPS.map((group) => group.id);

/** Rollen mit erweiterten Rechten: Assistent, Entwickler, Tester (Tests, Coverage) und Reviewer (git diff). */
export const TRUSTED_ROLES = new Set(['assistant', 'developer', 'tester', 'reviewer', 'routine']);
/**
 * Rollen mit Shell (unter dem Wächter), aber ohne Datei-Werkzeuge: zeitgesteuerte Routinen führen z. B. `npm audit`
 * aus, ändern aber nichts. Ergebnisse gehen nur über die Marker (@@BUG, @@IDEA, @@ORDER) weiter.
 */
export const NO_FILE_WRITE_ROLES = new Set(['routine']);
/**
 * Rollen, die nur lesen (Werkzeugumfang der Problemanalyse beim lokalen Modell): keine Datei-Werkzeuge, keine Shell –
 * auch nicht über eine eigene Zuweisung am Agent oder eigene Werkzeug-Regeln im Befehl.
 */
// pre_sprint: Agents „Vor dem Sprint“ planen und prüfen nur (ihre Änderungen würden sonst im ersten Auftrag landen).
export const READ_ONLY_ROLES = new Set(['visionary', 'analyst', 'pre_sprint']);
/** Rolle, deren (lesende) Rechte ein Agent bekommt, der vorübergehend nur lesen darf. */
export const READ_ONLY_PERMISSION_ROLE = 'analyst';
