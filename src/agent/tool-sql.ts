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

export function sqlViolation(sql: string): string | null {
  const withoutComments = sql.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');
  for (const [pattern, label] of FORBIDDEN_SQL) {
    if (pattern.test(withoutComments)) return `Nicht erlaubt: ${label}.`;
  }
  for (const statement of withoutComments.split(';')) {
    if (/^\s*(?:update|delete)\b/i.test(statement) && !/\bwhere\b/i.test(statement)) {
      return 'UPDATE und DELETE brauchen eine WHERE-Bedingung.';
    }
    if (/^\s*(?:update|delete)\b/i.test(statement) && TRIVIAL_WHERE.test(statement.trim())) {
      return 'UPDATE und DELETE brauchen eine echte WHERE-Bedingung (nicht „WHERE true“ o. ä.).';
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
