import pg from 'pg';

const MAX_ROWS = 50;
const STATEMENT_TIMEOUT_MS = 15_000;

/**
 * Statements that would leave the project database, affect the server or destroy data in bulk.
 * Allowed: DML with real WHERE conditions and additive DDL (CREATE TABLE, ALTER TABLE ADD …).
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
    /\b(?:pg_read_file|pg_read_binary_file|pg_ls_dir|lo_import|lo_export|pg_terminate_backend|dblink)\w*/i,
    'Server-Funktionen',
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

/** WHERE-Bedingungen, die jede Zeile treffen (z. B. „WHERE true“, „WHERE 1=1“). */
const TRIVIAL_WHERE =
  /\bwhere\s+(?:true|not\s+false|(\d+)\s*=\s*\1|'([^']*)'\s*=\s*'\2'|([a-z_][\w.]*)\s*=\s*\3)\s*(?:returning\b[\s\S]*)?$/i;

/**
 * Zerlegt SQL wie PostgreSQL in Code ohne Kommentare und String-Inhalte: '…' (mit ''), E'…' (mit Backslash-Escapes)
 * und $tag$…$tag$ werden zu '', Kommentare (-- und verschachtelte /* … *\/) zu Leerzeichen. Bezeichner in "…" bleiben
 * als Wort sichtbar (sonst versteckte "pg_read_file"(…) eine Server-Funktion). null bei offenem String oder Kommentar.
 */
function sqlCode(sql: string): string | null {
  let code = '';
  let index = 0;
  while (index < sql.length) {
    const char = sql[index] ?? '';
    const next = sql[index + 1];
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

/** Jede UPDATE/DELETE-Anweisung – auch in CTEs und hinter EXPLAIN – samt ihrem Text bis zum Ende ihrer Klammer. */
function dmlStatements(statement: string): string[] {
  const found: string[] = [];
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
    found.push(flatten(statement.slice(match.index, depth < 0 ? end - 1 : end)).trim());
  }
  return found;
}

export function sqlViolation(sql: string): string | null {
  const code = sqlCode(sql);
  if (code === null) return 'Nicht erlaubt: offener String, Bezeichner oder Kommentar.';
  for (const [pattern, label] of FORBIDDEN_SQL) {
    if (pattern.test(code)) return `Nicht erlaubt: ${label}.`;
  }
  if (/\bset_config\b/i.test(code)) return 'Nicht erlaubt: Einstellungen ändern (set_config).';
  for (const statement of code.split(';')) {
    if (SESSION_CONTROL.test(statement)) {
      return 'Nicht erlaubt: Transaktions-, Timeout- und Sitzungssteuerung (BEGIN, COMMIT, ROLLBACK, SET, RESET …).';
    }
    for (const dml of dmlStatements(statement)) {
      if (!/\bwhere\b/i.test(dml)) return 'UPDATE und DELETE brauchen eine WHERE-Bedingung.';
      if (TRIVIAL_WHERE.test(dml)) {
        return 'UPDATE und DELETE brauchen eine echte WHERE-Bedingung (nicht „WHERE true“ o. ä.).';
      }
    }
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

export interface SqlClient {
  connect(): Promise<unknown>;
  query(text: string): Promise<unknown>;
  end(): Promise<void>;
}

export type SqlClientFactory = (connectionString: string) => SqlClient;

const defaultFactory: SqlClientFactory = (connectionString) =>
  new pg.Client({ connectionString, connectionTimeoutMillis: 5_000 });

interface SqlResult {
  command?: string;
  rowCount?: number | null;
  rows?: unknown[];
}

/** Executes SQL in the project's own database inside one transaction (rolled back on any error). */
export async function runProjectSql(
  databaseUrl: string,
  sql: string,
  createClient: SqlClientFactory = defaultFactory,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  if (targetsDevLogDatabase(databaseUrl, environment)) {
    return 'Der hinterlegte Datenbank-Zugang zeigt auf die AIdeation-Datenbank und wird nicht verwendet.';
  }
  const violation = sqlViolation(sql);
  if (violation) return violation;
  const client = createClient(databaseUrl);
  try {
    await client.connect();
    await client.query('BEGIN');
    await client.query(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
    const raw = await client.query(sql);
    await client.query('COMMIT');
    const results = (Array.isArray(raw) ? raw : [raw]) as SqlResult[];
    return results
      .map((result) => {
        const rows = (result.rows ?? []).slice(0, MAX_ROWS);
        const more =
          (result.rows?.length ?? 0) > rows.length ? `\n[weitere ${result.rows!.length - rows.length} Zeilen]` : '';
        return `${result.command ?? 'OK'}: ${result.rowCount ?? 0} Zeile(n)${rows.length ? `\n${JSON.stringify(rows)}` : ''}${more}`;
      })
      .join('\n');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    return `SQL-Fehler: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    await client.end().catch(() => undefined);
  }
}
