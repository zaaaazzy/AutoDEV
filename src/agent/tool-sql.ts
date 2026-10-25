import pg from 'pg';
import { maskTokens } from '../core/secret-mask.js';

/** Höchstens so viele Zeilen werden gelesen und ausgegeben; die Zeile danach zeigt nur noch „mehr“ an. */
const MAX_ROWS = 50;
/** Obergrenze für die gelesenen Zeilen zusammen (als JSON gemessen); darüber wird die Abfrage abgebrochen. */
const MAX_RESULT_BYTES = 1_000_000;
/** Jede Zelle wird in der Ausgabe auf so viele Zeichen gekürzt, damit eine breite Spalte nicht alles verdrängt. */
const MAX_CELL_CHARS = 500;
const STATEMENT_TIMEOUT_MS = 15_000;
const LOCK_TIMEOUT_MS = 5_000;
const IDLE_IN_TRANSACTION_TIMEOUT_MS = 20_000;
const CONNECT_TIMEOUT_MS = 5_000;
/** Zeitlimit auf der Client-Seite: greift auch, wenn Server oder Netz hängen. */
const QUERY_TIMEOUT_MS = STATEMENT_TIMEOUT_MS + 5_000;
/** UPDATE/DELETE, die mehr Zeilen treffen, werden zurückgerollt; INSERT fügt nur hinzu und ist nicht begrenzt. */
export const MAX_DML_ROWS = 500;

/**
 * Statements that would leave the project database, affect the server or destroy data in bulk.
 * Erlaubt sind nur die Anweisungsarten in allowedStatement: Lesen, DML mit echter WHERE-Bedingung und additive DDL
 * (CREATE TABLE/INDEX/VIEW …, ALTER TABLE … ADD). Diese Liste sperrt zusätzlich Namen an jeder Stelle im SQL.
 * Das ist ein Schutz gegen Fehlgriffe des Modells, keine Sicherheitsgrenze: Dafür gehört in die
 * Projekteinstellungen ein Datenbank-Benutzer mit eingeschränkten Rechten.
 */
const FORBIDDEN_SQL: [RegExp, string][] = [
  [
    /\b(?:drop|alter|create)\s+(?:database|role|user|extension|system)\b/i,
    'Datenbank-, Rollen- und Erweiterungsverwaltung',
  ],
  [/\balter\s+system\b/i, 'ALTER SYSTEM'],
  [/\b(?:grant|revoke)\b/i, 'GRANT/REVOKE'],
  [/\bcopy\b/i, 'COPY'],
  [/\bset\s+(?:session\s+authorization|role)\b/i, 'Rollenwechsel'],
  [
    /\b(?:pg_read_file|pg_read_binary_file|pg_ls_dir|pg_stat_file|pg_file_|lo_import|lo_export|pg_terminate_backend|pg_cancel_backend|pg_reload_conf|pg_promote|dblink)\w*/i,
    'Server-Funktionen',
  ],
  // Führen SQL aus einem String aus; Strings sind für alle Prüfungen zu '' geleert.
  [
    /\b(?:query_to_xml|cursor_to_xml|table_to_xml|schema_to_xml|database_to_xml)\w*|\bts_(?:stat|rewrite)\b/i,
    'Funktionen, die SQL aus einem String ausführen (query_to_xml, ts_stat …)',
  ],
  [/\bdrop\s+schema\b/i, 'DROP SCHEMA'],
  [/\bdrop\s+(?:table|view|materialized\s+view|sequence|type|owned)\b/i, 'DROP (löscht Tabellen bzw. Daten)'],
  [/\btruncate\b/i, 'TRUNCATE'],
  [/\balter\s+table\b[^;]*\bdrop\b/i, 'Spalten oder Constraints löschen'],
  // Code im Server: damit ließen sich alle Namensprüfungen oben über dynamisches SQL umgehen.
  [/(?:^|;)\s*do\b/i, 'anonyme Code-Blöcke (DO)'],
  [/\bexecute\b/i, 'EXECUTE'],
  [
    /\bcreate\s+(?:or\s+replace\s+)?(?:function|procedure|trigger|rule|event\s+trigger)\b/i,
    'Funktionen, Prozeduren, Trigger',
  ],
  [/\blo_\w+/i, 'Large-Object-Funktionen'],
];

/** Wörter, die in einer Bedingung keinen Spaltenbezug herstellen. */
const CONSTANT_WORDS = new Set(['true', 'false', 'not', 'and', 'or', 'is', 'null', 'unknown', 'between', 'symmetric']);

/** Bedingung, die jede (nicht leere) Zeile trifft: „id = id“, „id IS NOT NULL“, „id IS NOT DISTINCT FROM id“. */
const SELF_COMPARISON =
  /^(?:([a-z_][\w.]*)\s*(?:=|>=|<=|is\s+not\s+distinct\s+from)\s*\1|[a-z_][\w.]*\s+is\s+not\s+null|[a-z_][\w.]*\s+notnull)$/i;

/** Teilt text an den Treffern von separator (mit Flag g), die außerhalb jeder Klammer liegen. */
function splitTopLevel(text: string, separator: RegExp): string[] {
  // Je UTF-16-Stelle wie match.index.
  const depth: number[] = [];
  let level = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === ')') level -= 1;
    depth.push(level);
    if (text[index] === '(') level += 1;
  }
  const parts: string[] = [];
  let start = 0;
  for (const match of text.matchAll(separator)) {
    if (depth[match.index] !== 0) continue;
    parts.push(text.slice(start, match.index));
    start = match.index + match[0].length;
  }
  parts.push(text.slice(start));
  return parts;
}

/** „(a)“ → „a“, wenn die erste Klammer erst am Ende schließt (bei „(a) OR (b)“ nicht); sonst null. */
function unwrap(text: string): string | null {
  if (!text.startsWith('(') || !text.endsWith(')')) return null;
  const inner = text.slice(1, -1);
  let depth = 0;
  for (const char of inner) {
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (depth < 0) return null;
  }
  return inner;
}

/**
 * WHERE-Bedingungen, die jede Zeile treffen: nur Konstanten („true“, „1=1“, „2>1“, „'a'='a'“, Strings sind hier schon
 * zu '' geleert), Vergleiche einer Spalte mit sich selbst oder „IS NOT NULL“ – auch als ein Zweig eines OR, als
 * Verknüpfung solcher Teile mit AND und in Klammern („WHERE (true)“). Das fängt Fehlgriffe ab, nicht jede Tautologie.
 */
function trivialCondition(condition: string): boolean {
  return splitTopLevel(condition, /\bor\b/gi).some((branch) =>
    splitTopLevel(branch, /\band\b/gi).every((part) => {
      const text = part.trim();
      if (!text) return true;
      const inner = unwrap(text);
      if (inner !== null) return trivialCondition(inner);
      if (SELF_COMPARISON.test(text)) return true;
      const words = text.match(/[a-z_][\w$]*/gi) ?? [];
      return words.every((word) => CONSTANT_WORDS.has(word.toLowerCase()));
    }),
  );
}

/** U& direkt vor einem String oder Bezeichner (Unicode-Escapes wie U&"\0073et_config"). */
const UNICODE_PREFIX = /(?:^|[^\w$])u&$/i;

class UnicodeEscapeError extends Error {}

/**
 * Zerlegt SQL wie PostgreSQL in Code ohne Kommentare und String-Inhalte: '…' (mit ''), E'…' (mit Backslash-Escapes)
 * und $tag$…$tag$ werden zu '', Kommentare (-- und verschachtelte /* … *\/) zu Leerzeichen. Bezeichner in "…" bleiben
 * als Wort sichtbar (sonst versteckte "pg_read_file"(…) eine Server-Funktion). null bei offenem String oder Kommentar,
 * UnicodeEscapeError bei U&'…' oder U&"…".
 */
function sqlCode(sql: string): string | null {
  let code = '';
  let index = 0;
  while (index < sql.length) {
    const char = sql[index] ?? '';
    const next = sql[index + 1];
    if ((char === "'" || char === '"') && UNICODE_PREFIX.test(code)) {
      // U&"\0073et_config" liest PostgreSQL als set_config – der Name wäre für alle Prüfungen unsichtbar.
      throw new UnicodeEscapeError();
    }
    if (char === '-' && next === '-') {
      const end = sql.indexOf('\n', index);
      index = end < 0 ? sql.length : end;
      code += ' ';
    } else if (char === '/' && next === '*') {
      let depth = 1;
      index += 2;
      while (index < sql.length && depth > 0) {
        if (sql.startsWith('/*', index)) {
          depth += 1;
          index += 2;
        } else if (sql.startsWith('*/', index)) {
          depth -= 1;
          index += 2;
        } else index += 1;
      }
      if (depth > 0) return null;
      code += ' ';
    } else if (char === "'") {
      const escapes = /[eE]/.test(code.at(-1) ?? '') && !/\w/.test(code.at(-2) ?? '');
      index += 1;
      for (;;) {
        if (index >= sql.length) return null;
        if (escapes && sql[index] === '\\') index += 2;
        else if (sql[index] === "'" && sql[index + 1] === "'") index += 2;
        else if (sql[index] === "'") break;
        else index += 1;
      }
      index += 1;
      code += "''";
    } else if (char === '"') {
      const end = sql.indexOf('"', index + 1);
      if (end < 0) return null;
      code += ` ${sql.slice(index + 1, end).replace(/\W/g, '_')} `;
      index = end + 1;
    } else if (char === '$' && !/\w/.test(code.at(-1) ?? '') && /^\$(?:[A-Za-z_]\w*)?\$/.test(sql.slice(index))) {
      const tag = /^\$(?:[A-Za-z_]\w*)?\$/.exec(sql.slice(index))?.[0] ?? '$$';
      const end = sql.indexOf(tag, index + tag.length);
      if (end < 0) return null;
      index = end + tag.length;
      code += "''";
    } else {
      code += char;
      index += 1;
    }
  }
  return code;
}

/** Steuert Transaktion oder Laufzeit – der Rahmen aus BEGIN und statement_timeout in runProjectSql muss gelten. */
const SESSION_CONTROL = /^\s*(?:begin|start|commit|end|rollback|abort|savepoint|release|prepare|set|reset|discard)\b/i;

/** Wörter vor UPDATE/DELETE, die keine schreibende Anweisung einleiten (FOR UPDATE, ON DELETE, DO UPDATE …). */
const NOT_DML_BEFORE = new Set(['for', 'key', 'on', 'of', 'or', 'before', 'after', 'instead', 'do']);

/** Inhalt verschachtelter Klammern ausblenden: aus „a (b (c)) d“ wird „a () d“. */
function flatten(text: string): string {
  let depth = 0;
  let flat = '';
  for (const char of text) {
    if (char === ')') depth -= 1;
    if (depth === 0) flat += char;
    if (char === '(') depth += 1;
  }
  return flat;
}

/**
 * Jede UPDATE/DELETE-Anweisung – auch in CTEs und hinter EXPLAIN – samt ihrem Text bis zum Ende ihrer Klammer.
 * nested: steht in einer Klammer (CTE); dort zählt rowCount ihre Zeilen nicht.
 */
function dmlStatements(statement: string): { text: string; nested: boolean }[] {
  const found: { text: string; nested: boolean }[] = [];
  for (const match of statement.matchAll(/\b(?:update|delete)\b/gi)) {
    const before = /(\w+)\W*$/.exec(statement.slice(0, match.index))?.[1]?.toLowerCase() ?? '';
    if (NOT_DML_BEFORE.has(before)) continue;
    let depth = 0;
    let end = match.index;
    while (end < statement.length && depth >= 0) {
      if (statement[end] === '(') depth += 1;
      if (statement[end] === ')') depth -= 1;
      end += 1;
    }
    found.push({ text: statement.slice(match.index, depth < 0 ? end - 1 : end).trim(), nested: depth < 0 });
  }
  return found;
}

/** Fehler zu einer UPDATE/DELETE-Anweisung (WHERE fehlt oder trifft jede Zeile), sonst null. */
function dmlViolation(dml: string): string | null {
  const [, ...afterWhere] = splitTopLevel(dml, /\bwhere\b/gi);
  if (!afterWhere.length) return 'UPDATE und DELETE brauchen eine WHERE-Bedingung.';
  const condition = splitTopLevel(afterWhere.join(' where '), /\breturning\b/gi)[0] ?? '';
  if (trivialCondition(condition)) {
    return 'UPDATE und DELETE brauchen eine echte WHERE-Bedingung (nicht „WHERE true“, „id IS NOT NULL“ o. ä.).';
  }
  return null;
}

/** Anweisungsarten, die gar nicht oder nur lesend bzw. hinzufügend wirken. */
const READ_OR_DML = /^(?:select|with|values|table|show|insert|update|delete)\b/i;
/** Additive DDL ohne OR REPLACE (ersetzte Sichten verlieren ihre alte Definition). */
const ADDITIVE_CREATE =
  /^create\s+(?:(?:(?:global|local)\s+)?(?:temp|temporary)\s+|unlogged\s+)?table\b|^create\s+(?:unique\s+)?index\b|^create\s+(?:materialized\s+)?view\b|^create\s+(?:sequence|schema|type)\b/i;
/** ALTER TABLE [IF EXISTS] [ONLY] name [*] Aktionen – Bezeichner in "…" sind hier schon zu Wörtern geworden. */
const ALTER_TABLE = /^alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?[\w$]+(?:\s*\.\s*[\w$]+)*\s*\*?\s+([\s\S]*)$/i;
/** Optionen nach EXPLAIN: „(…)“ ist schon ausgeblendet, sonst ANALYZE/VERBOSE. */
const EXPLAIN_PREFIX = /^explain\b\s*(?:(?:\(\)|analy[sz]e|verbose)\s*)*/i;

/** Allowlist der Anweisungsarten; statement ohne Kommentare und String-Inhalte. */
function allowedStatement(statement: string): string | null {
  const text = flatten(statement).trim().replace(EXPLAIN_PREFIX, '');
  if (READ_OR_DML.test(text) || ADDITIVE_CREATE.test(text)) return null;
  const alter = ALTER_TABLE.exec(text);
  if (alter) {
    // Jede Aktion muss ADD sein: kein RENAME, OWNER TO, DISABLE TRIGGER/ROW LEVEL SECURITY, ALTER COLUMN … TYPE.
    if (alter[1]?.split(',').every((action) => /^\s*add\b/i.test(action))) return null;
    return 'Nicht erlaubt: ALTER TABLE nur mit ADD (Spalten, Constraints, Indizes hinzufügen).';
  }
  const kind = /^\w+(?:\s+\w+)?/.exec(text)?.[0] ?? text.slice(0, 20);
  return (
    `Nicht erlaubt: ${kind.toUpperCase()}. Erlaubt sind SELECT, WITH, VALUES, TABLE, SHOW, INSERT, UPDATE, DELETE, ` +
    'EXPLAIN, CREATE TABLE/INDEX/VIEW/SEQUENCE/SCHEMA/TYPE (ohne OR REPLACE) und ALTER TABLE … ADD.'
  );
}

export function sqlViolation(sql: string): string | null {
  let code: string | null;
  try {
    code = sqlCode(sql);
  } catch (error) {
    if (error instanceof UnicodeEscapeError) return 'Nicht erlaubt: Unicode-Escapes (U&\'…\', U&"…").';
    throw error;
  }
  if (code === null) return 'Nicht erlaubt: offener String, Bezeichner oder Kommentar.';
  for (const [pattern, label] of FORBIDDEN_SQL) {
    if (pattern.test(code)) return `Nicht erlaubt: ${label}.`;
  }
  if (/\bset_config\b/i.test(code)) return 'Nicht erlaubt: Einstellungen ändern (set_config).';
  for (const statement of code.split(';')) {
    if (SESSION_CONTROL.test(statement)) {
      return 'Nicht erlaubt: Transaktions-, Timeout- und Sitzungssteuerung (BEGIN, COMMIT, ROLLBACK, SET, RESET …).';
    }
    const explain = EXPLAIN_PREFIX.test(statement.trim());
    for (const dml of dmlStatements(statement)) {
      const problem = dmlViolation(dml.text);
      if (problem) return problem;
      if (dml.nested || explain) {
        return (
          'Nicht erlaubt: UPDATE und DELETE in WITH (…) oder hinter EXPLAIN – dort greift die Zeilengrenze ' +
          `von ${MAX_DML_ROWS} nicht. Bitte als eigene Anweisung ausführen.`
        );
      }
    }
    if (statement.trim()) {
      const problem = allowedStatement(statement);
      if (problem) return problem;
    }
  }
  // Eine Anweisung pro Aufruf: nur so gelten Transaktionsrahmen, Zeitlimit und Zeilengrenze für das ganze SQL.
  if (code.split(';').filter((statement) => statement.trim()).length > 1) {
    return 'Nicht erlaubt: mehrere Anweisungen. Bitte eine Anweisung pro run_sql-Aufruf.';
  }
  return null;
}

/** Der Zugang eines Projekts darf nie auf die AIdeation-Datenbank selbst zeigen. */
export function targetsDevLogDatabase(databaseUrl: string, environment: NodeJS.ProcessEnv = process.env): boolean {
  const name = (value: string): string => {
    try {
      return decodeURIComponent(new URL(value).pathname.replace(/^\//, ''));
    } catch {
      return '';
    }
  };
  const devLogName = name(environment.DEV_LOG_DATABASE_URL ?? '') || 'aideation';
  return name(databaseUrl) === devLogName;
}

interface SqlResult {
  command?: string;
  rowCount?: number | null;
  rows?: unknown[];
}

export interface SqlClient {
  connect(): Promise<unknown>;
  query(text: string): Promise<unknown>;
  /**
   * Liest das Ergebnis Zeile für Zeile, ohne es zu sammeln. Fehlt die Methode (Fake-Clients in Tests), liest
   * runProjectSql über query() und wendet dieselben Grenzen danach an – der echte Client hat sie immer.
   */
  queryRows?(text: string, onRow: (row: unknown) => void): Promise<SqlResult>;
  /** Bricht die laufende Abfrage auf dem Server ab; end() allein beendet sie dort nicht zuverlässig. */
  cancel?(): Promise<void>;
  end(): Promise<void>;
}

export type SqlClientFactory = (config: pg.ClientConfig) => SqlClient;

/**
 * Verbindung mit Zeitlimits schon beim Anmelden: Sie gelten für die ganze Sitzung, auch wenn das SQL den Rahmen aus
 * BEGIN und SET LOCAL trotz Wächter verlassen sollte. query_timeout begrenzt zusätzlich das Warten im Client.
 */
export function connectionConfig(connectionString: string): pg.ClientConfig {
  return {
    connectionString,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    query_timeout: QUERY_TIMEOUT_MS,
    options:
      `-c statement_timeout=${STATEMENT_TIMEOUT_MS} -c lock_timeout=${LOCK_TIMEOUT_MS} ` +
      `-c idle_in_transaction_session_timeout=${IDLE_IN_TRANSACTION_TIMEOUT_MS}`,
  };
}

/**
 * pg.Client mit Zeilen-Stream statt pg-cursor (keine neue Abhängigkeit): Eine Query mit „row“-Listener reicht jede
 * Zeile einzeln weiter; runProjectSql behält höchstens MAX_ROWS davon und bricht darüber auf dem Server ab.
 */
function pgClient(config: pg.ClientConfig): SqlClient {
  const client = new pg.Client(config);
  // Ohne Listener brächte ein Verbindungsfehler (etwa nach end() mitten in der Abfrage) den Worker zum Absturz.
  client.on('error', () => undefined);
  return {
    connect: () => client.connect(),
    query: (text) => client.query(text),
    queryRows: (text, onRow) =>
      new Promise((resolve, reject) => {
        const query = new pg.Query(text);
        query.on('row', (row: unknown, ...rest: unknown[]) => {
          // Je nach pg-Version sammelt die Query die Zeilen zusätzlich – leeren, damit nichts anwächst.
          const collected = (rest[0] as SqlResult | undefined)?.rows;
          if (Array.isArray(collected)) collected.length = 0;
          onRow(row);
        });
        query.on('end', (raw: unknown) => {
          const result = raw as SqlResult;
          resolve({ command: result.command, rowCount: result.rowCount });
        });
        query.on('error', reject);
        client.query(query);
      }),
    cancel: async () => {
      const processID = (client as unknown as { processID?: number }).processID;
      if (!processID) return;
      const canceller = new pg.Client({ ...config, query_timeout: CONNECT_TIMEOUT_MS });
      canceller.on('error', () => undefined);
      try {
        await canceller.connect();
        await canceller.query('SELECT pg_cancel_backend($1)', [processID]);
      } finally {
        await canceller.end().catch(() => undefined);
      }
    },
    end: () => client.end(),
  };
}

/** Liest über queryRows oder – bei Clients ohne Stream – über query() und reicht die Zeilen einzeln an onRow. */
async function readRows(client: SqlClient, sql: string, onRow: (row: unknown) => void): Promise<SqlResult> {
  if (client.queryRows) return client.queryRows(sql, onRow);
  const raw = await client.query(sql);
  const result = (Array.isArray(raw) ? raw.at(-1) : raw) as SqlResult | undefined;
  for (const row of result?.rows ?? []) onRow(row);
  return { command: result?.command, rowCount: result?.rowCount };
}

/**
 * Eine Zelle für die Ausgabe: Tokens maskiert (vor dem Kürzen, sonst bliebe ein angeschnittener Schlüssel stehen),
 * lange Texte, JSON und bytea gekürzt, mit Markierung.
 */
function clipCell(value: unknown): unknown {
  let text: string;
  if (typeof value === 'string') text = maskTokens(value);
  else if (Buffer.isBuffer(value)) text = `\\x${value.toString('hex', 0, MAX_CELL_CHARS)}`;
  else if (value !== null && typeof value === 'object' && !(value instanceof Date)) text = JSON.stringify(value);
  else return value;
  const length = Buffer.isBuffer(value) ? 2 + value.length * 2 : text.length;
  if (length > MAX_CELL_CHARS) {
    return `${maskTokens(text).slice(0, MAX_CELL_CHARS)}… [gekürzt, ${length} Zeichen]`;
  }
  return typeof value === 'string' ? text : value;
}

const clipRow = (row: unknown): unknown =>
  row !== null && typeof row === 'object' && !Array.isArray(row)
    ? Object.fromEntries(Object.entries(row).map(([key, value]) => [key, clipCell(value)]))
    : clipCell(row);

// Maskiert: das Ergebnis landet im Chat, in der Anfragen-Doku und im Prompt-Protokoll (Tokens aus der Projekt-DB).
const rowsText = (rows: unknown[]): string => (rows.length ? `\n${maskTokens(JSON.stringify(rows.map(clipRow)))}` : '');

/**
 * Executes one SQL statement in the project's own database inside one transaction (rolled back on any error).
 * Grenzen: Zeitlimit auf Verbindung und Client, höchstens MAX_ROWS Zeilen und MAX_RESULT_BYTES beim Lesen, Abbruch
 * über signal, höchstens MAX_DML_ROWS geänderte Zeilen bei UPDATE/DELETE. Wird eine Grenze erreicht, bricht die
 * Abfrage ab bzw. wird zurückgerollt, und nichts wird gespeichert.
 */
export async function runProjectSql(
  databaseUrl: string,
  sql: string,
  createClient: SqlClientFactory = pgClient,
  environment: NodeJS.ProcessEnv = process.env,
  signal?: AbortSignal,
): Promise<string> {
  if (targetsDevLogDatabase(databaseUrl, environment)) {
    return 'Der hinterlegte Datenbank-Zugang zeigt auf die AIdeation-Datenbank und wird nicht verwendet.';
  }
  const violation = sqlViolation(sql);
  if (violation) return violation;
  if (signal?.aborted) return 'SQL abgebrochen: Der Agent wurde beendet.';
  const client = createClient(connectionConfig(databaseUrl));

  // Grund, aus dem runProjectSql die Abfrage beendet hat (Grenze, Zeitlimit, Abbruch); null solange sie läuft.
  let stopped = null as string | null;
  let rejectStop: (error: Error) => void = () => undefined;
  const stopping = new Promise<never>((_, reject) => {
    rejectStop = reject;
  });
  stopping.catch(() => undefined);
  const stop = (reason: string): void => {
    if (stopped) return;
    stopped = reason;
    rejectStop(new Error(reason));
    // Erst auf dem Server abbrechen, dann die Verbindung schließen (rollt die offene Transaktion zurück).
    void (client.cancel?.() ?? Promise.resolve())
      .catch(() => undefined)
      .finally(() => client.end().catch(() => undefined));
  };
  const step = <T>(promise: Promise<T>): Promise<T> => Promise.race([promise, stopping]);

  const timer = setTimeout(
    () => stop(`SQL-Zeitlimit: Abfrage nach ${QUERY_TIMEOUT_MS / 1000} s abgebrochen, nichts gespeichert.`),
    QUERY_TIMEOUT_MS,
  );
  const onAbort = (): void => stop('SQL abgebrochen: Der Agent wurde beendet, nichts gespeichert.');
  signal?.addEventListener('abort', onAbort, { once: true });

  const rows: unknown[] = [];
  let bytes = 0;
  const onRow = (row: unknown): void => {
    if (stopped) return;
    if (rows.length >= MAX_ROWS) {
      stop(
        `Ergebnis zu groß: mehr als ${MAX_ROWS} Zeilen. Abfrage abgebrochen, nichts gespeichert – ` +
          'bitte mit WHERE oder LIMIT eingrenzen.',
      );
      return;
    }
    bytes += JSON.stringify(row)?.length ?? 0;
    if (bytes > MAX_RESULT_BYTES) {
      stop(
        `Ergebnis zu groß: mehr als ${MAX_RESULT_BYTES / 1_000_000} MB. Abfrage abgebrochen, nichts gespeichert – ` +
          'bitte weniger Spalten oder Zeilen abfragen.',
      );
      return;
    }
    rows.push(row);
  };

  try {
    await step(client.connect());
    await step(client.query('BEGIN'));
    await step(client.query(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`));
    const result = await step(readRows(client, sql, onRow));
    const changed = result.rowCount ?? 0;
    if ((result.command === 'UPDATE' || result.command === 'DELETE') && changed > MAX_DML_ROWS) {
      // Noch in der Transaktion aus BEGIN: ROLLBACK verwirft genau diese Änderung.
      await step(client.query('ROLLBACK'));
      return (
        `Zu viele Zeilen: ${result.command} hätte ${changed} Zeilen geändert (Grenze ${MAX_DML_ROWS}). ` +
        'Zurückgerollt, nichts gespeichert – bitte die WHERE-Bedingung enger fassen.'
      );
    }
    try {
      // SAVEPOINT scheitert außerhalb einer Transaktion: Ist der Rahmen weg, wird kein Erfolg gemeldet.
      await step(client.query('SAVEPOINT aideation_check'));
    } catch (error) {
      if (stopped) throw error;
      return 'SQL-Fehler: Die Transaktion war vor dem COMMIT nicht mehr offen; das Ergebnis ist nicht bestätigt.';
    }
    const commit = (await step(client.query('COMMIT'))) as SqlResult | undefined;
    if (commit?.command === 'ROLLBACK') {
      return 'SQL-Fehler: Der Server hat die Transaktion zurückgerollt, nichts gespeichert.';
    }
    return `${result.command ?? 'OK'}: ${result.rowCount ?? 0} Zeile(n)${rowsText(rows)}`;
  } catch (error) {
    if (stopped) return `${stopped}${rowsText(rows)}`;
    await client.query('ROLLBACK').catch(() => undefined);
    const message = error instanceof Error ? error.message : String(error);
    // Fehlermeldungen zitieren Werte („Key (token)=(…) already exists“).
    return `SQL-Fehler: ${maskTokens(message.split(databaseUrl).join('[Datenbank-Zugang]'))}`;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    // Nach stop() schließt die Abbruch-Kette die Verbindung; nicht darauf warten, sie kann am Netz hängen.
    if (!stopped) await client.end().catch(() => undefined);
  }
}
