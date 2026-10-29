// Rechte-Regeln: Pseudo-Befehle, Datei-Werkzeuge, eingebaute Rechte-Gruppen und Rollen-Sets.
import { LEGACY_DOCKER_GROUP, LEGACY_SERVICE_RULE } from './legacy-rules.js';

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
/**
 * Dienste des Projekts über feste Worker-Aktionen (services.status/logs/restart/up/stop). Keine Shell-Regel: Der
 * Worker prüft und führt die Aktion selbst aus, kein Agent braucht docker oder den Docker-Socket.
 */
export const SERVICES_COMMAND = 'services';
/** Löschen bzw. Umbenennen: kommt mit „Dateien ändern“ (git mv zusätzlich mit „Dateien anlegen“), geprüft vom Wächter. */
export const GIT_RM_RULE = 'Bash(git rm:*)';
export const GIT_MV_RULE = 'Bash(git mv:*)';
export const fileGitRules = ({ create, edit }: { create: boolean; edit: boolean }): string[] => [
  ...(edit ? [GIT_RM_RULE] : []),
  ...(edit && create ? [GIT_MV_RULE] : []),
];
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

/**
 * Ersetzt frühere Regeln: „files“ durch Anlegen und Ändern, die früheren Dienst-Regeln (Betriebssystem-Dienste und
 * docker, siehe legacy-rules.ts) durch „services“. Idempotent: ein zweiter Durchlauf ändert nichts.
 */
export function normalizeCommands(rules: readonly string[]): string[] {
  return [
    ...new Set(
      rules.flatMap((rule) =>
        rule === LEGACY_FILES_COMMAND
          ? [FILES_CREATE, FILES_EDIT]
          : LEGACY_SERVICE_RULE.test(rule)
            ? [SERVICES_COMMAND]
            : [rule],
      ),
    ),
  ];
}

/** Freigeschaltete Gruppen eines Projekts: die frühere Gruppe „docker“ zählt als „services“ (null bleibt null). */
export function normalizeGroups(groups: readonly string[] | null): string[] | null {
  return groups ? [...new Set(groups.map((id) => (id === LEGACY_DOCKER_GROUP ? 'services' : id)))] : null;
}

/** Lesbare Bezeichnung eines Befehls für die Oberfläche (ohne Platzhalter für weitere Argumente). */
export function commandLabel(rule: string): string {
  if (rule === FILES_CREATE) return 'Dateien anlegen';
  if (rule === FILES_EDIT) return 'Dateien ändern';
  if (rule === LOGS_COMMAND) return '~/Library/Logs lesen';
  if (rule === DATABASE_COMMAND) return 'SQL auf der Projekt-Datenbank';
  if (rule === SERVICES_COMMAND) return 'Dienste: services.status/logs/restart/up/stop';
  const bash = rule.match(/^Bash\((.+?)(?::\*)?\)$/);
  if (bash) return bash[1]!;
  const web = rule.match(/^WebFetch\(domain:(.+)\)$/);
  return web ? `Webseiten auf ${web[1]} abrufen` : rule;
}

/** Erklärung je Befehl (Hover in der Oberfläche). */
const COMMAND_HELP: Record<string, string> = {
  [FILES_CREATE]:
    'Neue Dateien im Projektordner (bzw. in den erlaubten Ordnern) anlegen. Bestehende Dateien überschreiben braucht zusätzlich „Dateien ändern“; mit beiden Rechten auch umbenennen (git mv).',
  [FILES_EDIT]:
    'Bestehende Dateien im Projektordner (bzw. in den erlaubten Ordnern) bearbeiten, überschreiben oder löschen (git rm).',
  [GIT_RM_RULE]:
    'Löscht Dateien im Projekt (bzw. in den erlaubten Ordnern) – ohne -f, ohne geschützte Dateien wie .env oder .git. Kommt mit „Dateien ändern“.',
  [GIT_MV_RULE]:
    'Benennt Dateien im Projekt (bzw. in den erlaubten Ordnern) um – ohne -f, Quelle und Ziel nicht geschützt. Kommt mit „Dateien anlegen“ und „Dateien ändern“.',
  [SERVICES_COMMAND]:
    'Dienste des Projekts (Docker Compose im Projektordner) über den Worker: Status, Logs, Neustart, Start (optional mit Build) und Stopp – nicht AIdeation selbst. Der Agent braucht dafür weder docker noch den Docker-Socket.',
  [DATABASE_COMMAND]:
    'Liest und ändert die Projekt-Datenbank per SQL (Werkzeug run_sql des lokalen Modells; braucht eine hinterlegte Datenbank-URL).',
  [LOGS_COMMAND]: 'Liest Dienst-Logs unter ~/Library/Logs, z. B. das Log des Live-Modus (nur lesen).',
  'Bash(lsof -i:*)': 'Zeigt, welche Prozesse welche Netzwerk-Ports belegen.',
  'Bash(ps:*)': 'Listet laufende Prozesse (nur lesen).',
  'Bash(netstat:*)': 'Zeigt offene Netzwerkverbindungen und Ports (nur lesen).',
  'Bash(node --version:*)': 'Zeigt die installierte Node.js-Version.',
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
  'Bash(npm audit:*)': 'Prüft die Abhängigkeiten auf bekannte Sicherheitslücken (ohne „fix“, ändert nichts).',
  'Bash(npm outdated:*)': 'Listet veraltete Abhängigkeiten (nur lesen).',
  'Bash(git ls-files:*)': 'Listet die Dateien im Repository (nur lesen).',
  'Bash(git grep:*)': 'Durchsucht die Dateien im Repository (ohne Pager, nur Pfade im Projekt).',
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
      ...prefixRules(['lsof -i', 'ps', 'netstat', 'node --version']),
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
    id: 'services',
    label: 'Projekt-Dienste',
    // Keine Shell-Regel (weder docker noch Dienst-Befehle des Betriebssystems): Agents fordern feste Aktionen an,
    // der Worker prüft und führt sie aus.
    description:
      'Dienste des Projekts über den Worker: services.status, services.logs, services.restart, services.up (optional mit Build) und services.stop – nicht AIdeation selbst.',
    rules: [SERVICES_COMMAND],
  },
];

export const DEFAULT_PERMISSION_GROUPS = PERMISSION_GROUPS.map((group) => group.id);

/**
 * Eingebaute Prüf-Gruppe der Routinen (z. B. „Nächtlicher Sicherheits-Check“): nur lesende Befehle. Sie gehört zur
 * Rolle, nicht zu den schaltbaren Projektgruppen – andere Rollen (auch Entwickler) bekommen sie nie. „npm audit fix“,
 * „git grep -O“ und Pfade ausserhalb des Projekts sperrt der Wächter.
 */
export const CHECK_GROUP: PermissionGroup = {
  id: 'checks',
  label: 'Prüfbefehle',
  description: 'npm audit, npm outdated, git ls-files und git grep – nur lesen, nur für Routinen.',
  rules: prefixRules(['npm audit', 'npm outdated', 'git ls-files', 'git grep']),
};
/** Rollen, die die Prüf-Gruppe immer bekommen. */
export const CHECK_ROLES = new Set(['routine']);

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
