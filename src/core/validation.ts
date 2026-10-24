export const PRIORITIES = new Set(['low', 'medium', 'high']);
export const CATEGORIES = new Set(['frontend', 'backend', 'fullstack', 'infrastructure', 'docs', 'security']);
export const PROJECT_SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** Macht aus einer Eingabe wie „KeyGuard 1“ eine gültige Projekt-ID („keyguard-1“). */
export function normalizeProjectSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
}
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const BLOCKED_FOLDERS = [
  '/',
  '/Users',
  '/home',
  '/Volumes',
  '/etc',
  '/var',
  '/usr',
  '/bin',
  '/sbin',
  '/opt',
  '/root',
  '/System',
  '/Library',
  '/private',
  '/tmp',
  '/dev',
  '/proc',
];

/** Windows-Systemordner direkt unter einem Laufwerk (klein geschrieben, Windows unterscheidet keine Gross-/Kleinschreibung). */
const BLOCKED_WINDOWS_FOLDERS = [
  'windows',
  'program files',
  'program files (x86)',
  'programdata',
  'recovery',
  'perflogs',
  '$recycle.bin',
  'system volume information',
];

/** Pfad eines Windows-Rechners (Laufwerksbuchstabe), unabhängig davon, auf welchem System die Prüfung läuft. */
export const isWindowsPath = (path: string): boolean => /^[A-Za-z]:[\\/]/.test(path);

/**
 * Normalisiert einen absoluten Ordnerpfad des Rechners: `/a/b` (macOS/Linux) oder `C:\a\b` (Windows, Laufwerk gross,
 * Backslashes). Null bei relativen Pfaden, „.“/„..“, doppelten Trennern oder unter Windows unzulässigen Zeichen.
 * Bewusst ohne node:path – der Server prüft im Linux-Container Pfade eines Windows-Rechners.
 */
export function normalizeFolder(value: string): string | null {
  if (isWindowsPath(value)) {
    const parts = value.slice(3).split(/[\\/]/);
    if (parts.at(-1) === '') parts.pop();
    // Windows entfernt Punkte und Leerzeichen am Namensende („..“ hiesse sonst auch „.. “ oder „...“).
    if (parts.some((part) => !part || /[<>:"|?*]/.test(part) || /[. ]$/.test(part))) return null;
    return `${value[0]!.toUpperCase()}:\\${parts.join('\\')}`;
  }
  if (!value.startsWith('/') || value.includes('//')) return null;
  const parts = value.split('/').filter(Boolean);
  if (parts.some((part) => part === '..' || part === '.')) return null;
  return `/${parts.join('/')}`;
}

/** Liegt `path` (normalisiert) in `root` oder ist er `root` selbst? Windows-Pfade ohne Gross-/Kleinschreibung. */
export function insideFolder(path: string, root: string, strict = false): boolean {
  if (isWindowsPath(path) !== isWindowsPath(root)) return false;
  const [a, b] = isWindowsPath(path) ? [path.toLowerCase(), root.toLowerCase()] : [path, root];
  const separator = isWindowsPath(path) ? '\\' : '/';
  return (!strict && a === b) || a.startsWith(b.endsWith(separator) ? b : `${b}${separator}`);
}

/**
 * Projektbereich: Ordner, in denen AIdeation Projekte anlegen, löschen und bearbeiten darf (DEV_LOG_PROJECT_ROOTS).
 * Getrennt mit „:“ (macOS/Linux) oder „;“ (Windows); der Doppelpunkt nach einem Laufwerksbuchstaben trennt nicht.
 */
export function projectRoots(environment: NodeJS.ProcessEnv = process.env): string[] {
  return (environment.DEV_LOG_PROJECT_ROOTS ?? '')
    .split(';')
    .flatMap((entry) => entry.match(/\s*[A-Za-z]:[\\/][^:]*|[^:]+/g) ?? [])
    .map((root) => root.trim())
    .map((root) => (isWindowsPath(root) ? normalizeFolder(root) : root.replace(/\/+$/, '')))
    .filter((root): root is string => Boolean(root && (root.startsWith('/') || isWindowsPath(root))));
}

function blockedWindowsFolder(folder: string): boolean {
  const parts = folder.slice(3).toLowerCase().split('\\').filter(Boolean);
  return (
    parts.length === 0 ||
    BLOCKED_WINDOWS_FOLDERS.includes(parts[0]!) ||
    (parts[0] === 'users' && (parts.length <= 2 || parts[2] === 'appdata'))
  );
}

function blockedPosixFolder(folder: string): boolean {
  return (
    BLOCKED_FOLDERS.includes(folder) ||
    /^\/(?:Users|home)\/[^/]+$/.test(folder) ||
    /^\/Volumes\/[^/]+$/.test(folder) ||
    /^\/(?:etc|usr|bin|sbin|System|Library|private|dev|proc|root)(?:\/|$)/.test(folder)
  );
}

/**
 * Projektordner müssen absolut, normalisiert und unterhalb eines Benutzer-/Datenträgerordners liegen (optional per
 * DEV_LOG_PROJECT_ROOTS begrenzt). Gilt für macOS/Linux-Pfade und Windows-Pfade mit Laufwerksbuchstaben.
 */
export function projectFolderError(value: unknown, environment: NodeJS.ProcessEnv = process.env): string | null {
  const folder = typeof value === 'string' ? value.trim() : '';
  if ((!folder.startsWith('/') && !isWindowsPath(folder)) || folder.length > 500 || folder.includes('\0')) {
    return 'Projektordner muss ein absoluter Pfad sein, z. B. /Users/name/projekte/mein-projekt oder C:\\Users\\name\\projekte\\mein-projekt.';
  }
  const normalized = normalizeFolder(folder);
  if (!normalized) {
    return isWindowsPath(folder)
      ? 'Projektordner darf keine "." oder "..", leeren Namen oder Zeichen wie <>:"|?* enthalten.'
      : 'Projektordner darf keine "." oder ".." enthalten.';
  }
  if (isWindowsPath(normalized) ? blockedWindowsFolder(normalized) : blockedPosixFolder(normalized)) {
    return 'Dieser Ordner ist als Projektordner nicht erlaubt (zu breit oder Systemordner). Wähle den Projektunterordner.';
  }
  const roots = projectRoots(environment);
  if (roots.length && !roots.some((root) => insideFolder(normalized, root, true))) {
    return `Projektordner muss unterhalb von ${roots.join(' oder ')} liegen (DEV_LOG_PROJECT_ROOTS).`;
  }
  return null;
}

export const INVALID = Symbol('invalid');
export type Parser = (value: unknown) => unknown;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Höchstlänge für neue Titel (Ideen, Aufträge, Bugs); bestehende längere Titel bleiben bearbeitbar (DB: 180). */
export const TITLE_MAX = 80;
const TITLE_TARGET = 60;

/** Kürzt einen Titel an einer Wortgrenze auf höchstens `max` Zeichen (mit „…“). */
export function shortTitle(title: string, max = TITLE_TARGET): string {
  const clean = title.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.–-]+$/, '')}…`;
}

export function validText(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= maxLength;
}

export function validStatus(value: unknown, options: Set<string>): value is string {
  return typeof value === 'string' && options.has(value);
}

export function parseProjectSlug(value: string): string | null {
  return PROJECT_SLUG.test(value) ? value : null;
}

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

export const parseTitle =
  (max: number): Parser =>
  (value) =>
    validText(value, max) ? value.trim() : INVALID;
export const parseLongText: Parser = (value) =>
  typeof value === 'string' && value.length <= 10_000 ? value.trim() : INVALID;
export const parseOption =
  (options: Set<string>): Parser =>
  (value) =>
    validStatus(value, options) ? value : INVALID;
/** Kategorie oder leer (null = keine Kategorie). */
export const parseCategory: Parser = (value) =>
  value === null || value === '' ? null : validStatus(value, CATEGORIES) ? value : INVALID;
export const parseNullableUuid: Parser = (value) => (value === null || isUuid(value) ? value : INVALID);
export const parseNullableDate: Parser = (value) => {
  if (value === null || value === '') {
    return null;
  }
  return typeof value === 'string' && DATE_PATTERN.test(value) && !Number.isNaN(Date.parse(value)) ? value : INVALID;
};
export const parseCommand: Parser = (value) => {
  if (value === null) {
    return null;
  }
  return Array.isArray(value) &&
    value.length >= 1 &&
    value.length <= 40 &&
    value.every((part) => typeof part === 'string' && part.length > 0 && part.length <= 500)
    ? value
    : INVALID;
};
export const parseBoolean: Parser = (value) => (typeof value === 'boolean' ? value : INVALID);
const nullableNumber =
  (min: number, max: number, integer: boolean): Parser =>
  (value) => {
    if (value === null) {
      return null;
    }
    return typeof value === 'number' &&
      Number.isFinite(value) &&
      value >= min &&
      value <= max &&
      (!integer || Number.isInteger(value))
      ? value
      : INVALID;
  };

export const ESTIMATE_FIELDS: Record<string, { column: string; parse: Parser }> = {
  effortHours: { column: 'effort_hours', parse: nullableNumber(0, 100_000, false) },
  tokenEstimate: { column: 'token_estimate', parse: nullableNumber(0, 1_000_000_000, true) },
  benefit: { column: 'benefit', parse: nullableNumber(0, 10, true) },
  cost: { column: 'cost', parse: nullableNumber(0, 10, true) },
};

/** Spalten, deren Herkunft `estimate_source` festhält (Nutzen und Kosten werden nicht kalibriert). */
const CALIBRATED_COLUMNS = new Set(['effort_hours', 'token_estimate']);

/**
 * Zusatz für ein UPDATE aus `buildUpdate`: Ändert jemand Aufwand oder Token-Schätzung von Hand, gilt die Schätzung als
 * `manual` und bleibt vor dem Auftragsautor geschützt. Unveränderte Werte zählen nicht, denn Formulare senden alle
 * Felder mit. Die Platzhalter sind die von `buildUpdate` ($2 = erstes Feld).
 */
export function manualEstimateSql(fields: { column: string }[]): string {
  const changed = fields.flatMap((field, index) =>
    CALIBRATED_COLUMNS.has(field.column) ? [`${field.column} IS DISTINCT FROM $${index + 2}`] : [],
  );
  return changed.length
    ? `, estimate_source = CASE WHEN ${changed.join(' OR ')} THEN 'manual' ELSE estimate_source END`
    : '';
}

export type FieldSpec = Record<string, { column: string; parse: Parser }>;

/** Parses the provided body keys against a whitelist; returns null if empty or invalid. */
export function parseFields(body: unknown, spec: FieldSpec): { column: string; value: unknown }[] | null {
  if (!isRecord(body)) {
    return null;
  }
  const fields: { column: string; value: unknown }[] = [];
  for (const [key, entry] of Object.entries(spec)) {
    if (body[key] === undefined) {
      continue;
    }
    const value = entry.parse(body[key]);
    if (value === INVALID) {
      return null;
    }
    fields.push({ column: entry.column, value });
  }
  return fields.length ? fields : null;
}

/** Deutsche Feldnamen für Fehlermeldungen; unbekannte Schlüssel erscheinen wie gesendet. */
const FIELD_LABELS: Record<string, string> = {
  title: 'Titel',
  name: 'Name',
  description: 'Beschreibung',
  content: 'Inhalt',
  goal: 'Sprint-Ziel',
  status: 'Status',
  priority: 'Priorität',
  severity: 'Schweregrad',
  category: 'Kategorie',
  sprintId: 'Sprint',
  agentId: 'Agent',
  ideationId: 'Idee',
  testRunId: 'Testlauf',
  startDate: 'Startdatum',
  endDate: 'Enddatum',
  fixNotes: 'Behebungsnotiz',
  effortHours: 'Aufwand',
  tokenEstimate: 'Token-Schätzung',
  benefit: 'Nutzen',
  cost: 'Kosten',
  role: 'Rolle',
  phase: 'Phase',
  instructions: 'Anweisungen',
  enabled: 'Aktiv',
  command: 'Befehl',
  fileScope: 'Dateibereich',
  handoffTo: 'Übergabe an',
};

export type InvalidInput = { message: string; field?: string };

/**
 * Erklärt, warum parseFields scheiterte: erstes fehlendes Pflichtfeld oder erstes ungültige Feld.
 * `field` ist der Schlüssel aus dem Body, damit die Oberfläche den Fehler direkt am Feld zeigen kann.
 */
export function invalidInput(body: unknown, spec: FieldSpec, required: readonly string[] = []): InvalidInput {
  if (!isRecord(body)) {
    return { message: 'Die Anfrage enthält keine Angaben.' };
  }
  for (const key of required) {
    const value = body[key];
    if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) {
      return { field: key, message: `Bitte ${FIELD_LABELS[key] ?? key} angeben.` };
    }
  }
  for (const [key, entry] of Object.entries(spec)) {
    if (body[key] !== undefined && entry.parse(body[key]) === INVALID) {
      return { field: key, message: `${FIELD_LABELS[key] ?? key}: ungültiger Wert.` };
    }
  }
  return { message: 'Keine gültigen Angaben zum Speichern.' };
}

/**
 * Builds a parameterised UPDATE. Table and columns come from code constants, never from input.
 * `onlyIf` limits the update to rows whose column still has one of the given values (atomic status check).
 */
export function buildUpdate(
  table: string,
  id: string,
  fields: { column: string; value: unknown }[],
  returning: string,
  onlyIf?: { column: string; values: readonly unknown[] },
): { sql: string; values: unknown[] } {
  const assignments = fields.map((field, index) => `${field.column} = $${index + 2}`);
  const values = [id, ...fields.map((field) => field.value)];
  const condition = onlyIf ? ` AND ${onlyIf.column} = ANY($${values.push([...onlyIf.values])})` : '';
  return {
    sql: `UPDATE ${table} SET ${assignments.join(', ')}, updated_at = NOW() WHERE id = $1${condition} RETURNING ${returning}`,
    values,
  };
}
