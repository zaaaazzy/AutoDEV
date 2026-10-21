import assert from 'node:assert/strict';
import test from 'node:test';
import type { CommandExecutor } from '../core/command.js';
import type { PushMessage } from '../core/push.js';
import { deployProject } from './deploy.js';
import { errorFingerprint, fingerprint } from './production-events.js';
import { FakeProductionDb } from './production-fake-db.test.js';
import {
  checkHealth,
  evaluateAlerts,
  type Fetcher,
  healthUrlError,
  linesInWindow,
  LOG_MAX_WINDOW_MS,
  logTimestamp,
  logWindow,
  nextHealth,
  parseComposeLogs,
  ProductionMonitor,
  purgeProductionData,
  scanLogs,
  updateAlerts,
} from './production-monitor.js';

test('Health-URL: nur http(s) auf localhost, LAN oder eigener Domain', () => {
  const env = { DEV_LOG_DOMAIN: 'devlog.moser.ch', DEV_LOG_OWN_DOMAINS: 'mainty.ch, *.example.org' };
  for (const url of [
    'http://localhost:8080/health',
    'http://127.0.0.1/health',
    'https://192.168.1.20/health',
    'http://10.0.0.5:3000/',
    'http://172.20.0.3/health',
    'http://[::1]:8080/health',
    'http://[fd12::1]/',
    'http://nas:8080/health',
    'http://app.local/health',
    'http://host.docker.internal:3000/health',
    'https://devlog.moser.ch/health',
    'https://api.mainty.ch/health',
    'https://shop.example.org/health',
  ]) {
    assert.equal(healthUrlError(url, env), null, url);
  }
  for (const url of [
    'ftp://localhost/health',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'https://google.com/health',
    'https://evilmainty.ch/',
    'http://8.8.8.8/',
    'http://169.254.169.254/latest/meta-data',
    'http://0.0.0.0/',
    'http://user:pass@localhost/health',
    'kein link',
  ]) {
    assert.notEqual(healthUrlError(url, env), null, url);
  }
});

test('Zwei Fehlschläge in Folge sind ein Ausfall, einer nicht; Erfolg danach ist die Erholung', () => {
  const one = nextHealth({ failures: 0, down: false }, false);
  assert.deepEqual(one, { failures: 1, down: false, change: null });
  const two = nextHealth(one, false);
  assert.deepEqual(two, { failures: 2, down: true, change: 'down' });
  assert.equal(nextHealth(two, false).change, null, 'anhaltend: keine neue Änderung');
  assert.deepEqual(nextHealth(two, true), { failures: 0, down: false, change: 'recovered' });
  assert.equal(nextHealth(one, true).change, null);
});

const failing: Fetcher = async () => {
  throw Object.assign(new Error('fetch failed'), { cause: new Error('connect ECONNREFUSED 127.0.0.1:8080') });
};
const healthy: Fetcher = async () => ({ status: 200 });

test('Health-Ausfall: genau ein kritischer Bug „Anwendung nicht erreichbar“, Push beim Ausfall und Entwarnung', async () => {
  const db = new FakeProductionDb({ healthUrl: 'http://localhost:8080/health' });
  const sent: PushMessage[] = [];
  const notify = async (_pool: unknown, message: PushMessage) => (sent.push(message), 1);
  const tick = async (fetcher: Fetcher) => {
    await checkHealth(db.pool, 'shop', fetcher);
    await updateAlerts(db.pool, 'shop', new Date(), notify);
  };

  await tick(failing);
  assert.equal(db.bugs.length, 0, 'ein einzelner Fehlschlag erzeugt keinen Bug');
  assert.equal(sent.length, 0, 'und keine Meldung');

  await tick(failing);
  assert.equal(db.bugs.length, 1);
  assert.deepEqual(
    [db.bugs[0]!.title, db.bugs[0]!.severity, db.bugs[0]!.source],
    ['Anwendung nicht erreichbar', 'critical', 'production'],
  );
  assert.equal(sent.length, 1);
  assert.match(sent[0]!.title, /Shop: Fehler im Betrieb/);
  assert.match(sent[0]!.body, /Anwendung nicht erreichbar/);

  await tick(failing);
  assert.equal(db.bugs.length, 1, 'anhaltender Ausfall: kein zweiter Bug');
  assert.equal(db.events[0]!.count, 3);
  assert.equal(sent.length, 1, 'und keine neue Meldung vor Ablauf von 6 Stunden');

  await tick(healthy);
  assert.equal(sent.length, 2);
  assert.match(sent[1]!.title, /Entwarnung/);
});

test('Meldungen folgen dem Wächter: anhaltend alle 6 Stunden, Entwarnung auch für einzelne Probleme', () => {
  const start = evaluateAlerts({ problems: [], notifiedAt: null }, ['A', 'B'], 1_000, 'Shop');
  assert.match(start.message?.title ?? '', /Fehler im Betrieb/);
  assert.equal(evaluateAlerts(start.state, ['A', 'B'], 2_000, 'Shop').message, null);
  assert.match(
    evaluateAlerts(start.state, ['A', 'B'], 1_000 + 6 * 3600_000, 'Shop').message?.title ?? '',
    /besteht weiterhin/,
  );
  const partly = evaluateAlerts(start.state, ['B'], 3_000, 'Shop');
  assert.match(partly.message?.title ?? '', /Entwarnung/);
  assert.match(partly.message?.body ?? '', /Behoben: A/);
});

const LOGS = [
  'api-1  | 2026-10-18T10:00:00.000Z INFO server started on port 3000',
  'api-1  | TypeError: Cannot read properties of undefined (reading "id")',
  'api-1  |     at loadOrder (/app/src/orders.js:41:13)',
  'api-1  |     at Layer.handle (/app/node_modules/express/lib/router/layer.js:95:5)',
  'web-1  | 10.0.0.7 - - [18/Oct/2026:10:00:01 +0000] "GET /kasse HTTP/1.1" 502 157 "-" "Mozilla"',
  'web-1  | 10.0.0.7 - - [18/Oct/2026:10:00:02 +0000] "GET /health HTTP/1.1" 200 2 "-" "curl"',
  'worker-1  | Traceback (most recent call last):',
  'worker-1  |   File "/app/job.py", line 12, in <module>',
  'worker-1  |     run()',
  'worker-1  |   File "/app/job.py", line 8, in run',
  'worker-1  |     raise ValueError("bad 42")',
  'worker-1  | ValueError: bad 42',
  'api-1  | ERROR healthcheck noise from monitoring 17',
].join('\n');

test('Log-Scan erkennt Stacktraces, ERROR-Zeilen und HTTP-5xx und überspringt Ausschlussmuster', () => {
  const errors = parseComposeLogs(LOGS, ['Healthcheck noise']);
  // Je Dienst endet ein Fehler mit der nächsten Zeile dieses Dienstes, daher diese Reihenfolge.
  assert.deepEqual(
    errors.map((error) => [error.origin, error.message]),
    [
      ['web', '10.0.0.7 - - [18/Oct/2026:10:00:01 +0000] "GET /kasse HTTP/1.1" 502 157 "-" "Mozilla"'],
      ['worker', 'ValueError: bad 42'],
      ['api', 'TypeError: Cannot read properties of undefined (reading "id")'],
    ],
  );
  assert.match(errors[2]!.stack ?? '', /^at loadOrder \(\/app\/src\/orders\.js:41:13\)/);
  assert.match(errors[1]!.stack ?? '', /line 8, in run$/);
  assert.equal(parseComposeLogs(LOGS).length, 4, 'ohne Ausschlussmuster auch die Monitoring-Zeile');
});

test('Ein Fehler, der zehnmal in den Logs auftaucht, ergibt genau einen Bug mit Zähler 10', async () => {
  const db = new FakeProductionDb({ logServices: ['api'] });
  const output = Array.from(
    { length: 10 },
    (_, index) => `api-1  | ERROR order ${1000 + index} could not be saved`,
  ).join('\n');
  const commands: string[][] = [];
  const execute: CommandExecutor = async (command) => (commands.push(command), { exitCode: 0, durationMs: 1, output });
  const result = await scanLogs(db.pool, 'shop', '/projects/shop', execute, new Date('2026-10-18T10:15:00Z'));
  assert.deepEqual(result, { events: 1, occurrences: 10 });
  // Erster Scan: das Standardintervall von 15 Minuten.
  assert.deepEqual(commands[0], [
    'docker',
    'compose',
    'logs',
    '--timestamps',
    '--since',
    '2026-10-18T10:00:00.000Z',
    '--no-color',
    'api',
  ]);
  assert.equal(db.bugs.length, 1);
  assert.equal(db.events[0]!.count, 10);
  assert.equal(db.events[0]!.source, 'logs');
});

/** Ausgabe wie `docker compose logs --timestamps`: Dienst, Zeitstempel, Text. */
const stamped = (at: string, text: string, service = 'api-1') => `${service}  | ${at} ${text}`;

/** Executor, der die Ausgabe liefert und die Befehle sammelt. */
function logsExecutor(output: () => string, commands: string[][] = []): CommandExecutor {
  return async (command) => (commands.push(command), { exitCode: 0, durationMs: 1, output: output() });
}

test('Zeitstempel von --timestamps: Nanosekunden und Offsets werden millisekundengenau gelesen', () => {
  assert.equal(logTimestamp('2026-10-18T10:00:00.123456789Z ERROR x')?.at, Date.parse('2026-10-18T10:00:00.123Z'));
  assert.equal(logTimestamp('2026-10-18T12:00:00+02:00 ERROR x')?.at, Date.parse('2026-10-18T10:00:00Z'));
  assert.equal(logTimestamp('2026-10-18T12:00:00.5+0200 x')?.at, Date.parse('2026-10-18T10:00:00.500Z'));
  assert.equal(logTimestamp('ERROR ohne Zeitstempel'), null);
  const output = [
    stamped('2026-10-18T09:59:59.000Z', 'ERROR alt'),
    'api-1  |     at alt (/app/a.js:1:1)',
    stamped('2026-10-18T10:00:00.000Z', 'ERROR auf der Grenze'),
    stamped('2026-10-18T10:00:00.001Z', 'ERROR neu'),
    'api-1  |     at neu (/app/n.js:1:1)',
    stamped('2026-10-18T10:15:00.001Z', 'ERROR nach dem Scan-Zeitpunkt'),
  ].join('\n');
  assert.equal(
    linesInWindow(output, new Date('2026-10-18T10:00:00.000Z'), new Date('2026-10-18T10:15:00.000Z')),
    'api-1  | ERROR neu\napi-1  |     at neu (/app/n.js:1:1)',
  );
});

test('Verspäteter Tick: das Fenster deckt den ganzen Abstand seit dem letzten Scan ab', async () => {
  const db = new FakeProductionDb({ logServices: ['api'] });
  const commands: string[][] = [];
  let output = '';
  const execute = logsExecutor(() => output, commands);
  await scanLogs(db.pool, 'shop', '/x', execute, new Date('2026-10-18T10:00:00Z'));
  // 20 Minuten später (über dem Intervall): Fehler von 10:02 lägen ausserhalb eines festen 15-Minuten-Fensters.
  output = Array.from({ length: 3 }, () => stamped('2026-10-18T10:02:00Z', 'ERROR verspätet gesehen')).join('\n');
  assert.deepEqual(await scanLogs(db.pool, 'shop', '/x', execute, new Date('2026-10-18T10:20:00Z')), {
    events: 1,
    occurrences: 3,
  });
  assert.equal(commands[1]![5], '2026-10-18T10:00:00.000Z', 'Fenster beginnt beim letzten erfolgreichen Scan');
  assert.equal(db.events[0]!.count, 3);
  assert.equal(db.status.get('shop')?.logGap, null, 'keine Lücke');
});

test('Überlappende Fenster: dieselbe Fehlerzeile in zwei Scans wird genau einmal gezählt', async () => {
  const db = new FakeProductionDb({ logServices: ['api'] });
  // docker liefert die Zeile in beiden Scans (z. B. weil --since sekundengenau rundet).
  const output = stamped('2026-10-18T10:00:30Z', 'ERROR doppelt geliefert');
  const execute = logsExecutor(() => output);
  await scanLogs(db.pool, 'shop', '/x', execute, new Date('2026-10-18T10:01:00Z'));
  assert.deepEqual(await scanLogs(db.pool, 'shop', '/x', execute, new Date('2026-10-18T10:02:00Z')), {
    events: 0,
    occurrences: 0,
  });
  assert.equal(db.events.length, 1);
  assert.equal(db.events[0]!.count, 1);
});

test('Scan nach dem Deploy und Takt gleichzeitig: dieselben Zeilen zählen nur einmal', async () => {
  const db = new FakeProductionDb({ logServices: ['api'] });
  await scanLogs(
    db.pool,
    'shop',
    '/x',
    logsExecutor(() => ''),
    new Date('2026-10-18T10:00:00Z'),
  );
  const output = stamped('2026-10-18T10:05:00Z', 'ERROR gleichzeitig');
  const now = new Date('2026-10-18T10:10:00Z');
  await Promise.all([
    scanLogs(
      db.pool,
      'shop',
      '/x',
      logsExecutor(() => output),
      now,
    ),
    scanLogs(
      db.pool,
      'shop',
      '/x',
      logsExecutor(() => output),
      now,
    ),
  ]);
  assert.equal(db.events[0]!.count, 1);
});

test('Letzter Scan zu lange her: Fenster wird begrenzt und die Lücke im Scan-Status vermerkt', async () => {
  const db = new FakeProductionDb({ logServices: ['api'] });
  const commands: string[][] = [];
  let output = '';
  const execute = logsExecutor(() => output, commands);
  await scanLogs(db.pool, 'shop', '/x', execute, new Date('2026-10-18T10:00:00Z'));
  output = [
    stamped('2026-10-18T11:00:00Z', 'ERROR vor dem Fenster'),
    stamped('2026-10-18T13:30:00Z', 'ERROR im Fenster'),
  ].join('\n');
  const now = new Date('2026-10-18T14:00:00Z');
  assert.deepEqual(logWindow(new Date('2026-10-18T10:00:00Z'), now).since, new Date(now.getTime() - LOG_MAX_WINDOW_MS));
  assert.deepEqual(await scanLogs(db.pool, 'shop', '/x', execute, now), { events: 1, occurrences: 1 });
  assert.equal(commands[1]![5], '2026-10-18T13:00:00.000Z');
  assert.equal(
    db.status.get('shop')?.logGap,
    'Logs von 2026-10-18 10:00 UTC bis 2026-10-18 13:00 UTC nicht gelesen (letzter erfolgreicher Scan zu lange her).',
  );
  assert.equal(db.status.get('shop')?.logsScannedAt, now);
  // Der Vermerk bleibt, bis eine neue Lücke entsteht.
  await scanLogs(db.pool, 'shop', '/x', execute, new Date('2026-10-18T14:15:00Z'));
  assert.match(db.status.get('shop')?.logGap ?? '', /10:00 UTC bis 2026-10-18 13:00 UTC/);
});

test('Gruppierung im Log-Scan und Speichern nutzen denselben Fingerabdruck', async () => {
  const db = new FakeProductionDb({ logServices: ['api'] });
  const output = [
    'api-1  | TypeError: Cannot read properties of undefined (reading "id")',
    'api-1  |     at loadOrder (/app/src/orders.js:41:13)',
  ].join('\n');
  const [error] = parseComposeLogs(output);
  const execute = logsExecutor(() => output);
  await scanLogs(db.pool, 'shop', '/x', execute, new Date('2026-10-18T10:00:00Z'));
  assert.equal(db.events[0]!.fingerprint, errorFingerprint(error!));
  assert.equal(db.events[0]!.fingerprint, fingerprint(error!.message, error!.stack));
  // Mit Titel zählt der Titel – im Log-Scan genauso wie in recordEvent.
  assert.equal(errorFingerprint({ ...error!, title: 'Titel' }), fingerprint('Titel', error!.stack));
});

test('Ungültige Dienstnamen werden nicht an docker compose logs übergeben', async () => {
  const commands: string[][] = [];
  const execute = logsExecutor(() => '', commands);
  const db = new FakeProductionDb({ logServices: ['api', '-v', '--since=0', 'web;rm -rf /', 'a b', '$(id)', 'db_1'] });
  await scanLogs(db.pool, 'shop', '/x', execute, new Date('2026-10-18T10:00:00Z'));
  assert.deepEqual(commands[0]!.slice(7), ['api', 'db_1']);
  const invalid = new FakeProductionDb({ logServices: ['-v', '../x'] });
  assert.equal(await scanLogs(invalid.pool, 'shop', '/x', execute), null);
  assert.equal(commands.length, 1, 'ohne gültigen Dienst kein Aufruf');
});

test('Fehlgeschlagenes docker compose logs setzt log_error, legt nichts an; der nächste Erfolg setzt zurück', async () => {
  const db = new FakeProductionDb({ logServices: ['api'] });
  const failing: CommandExecutor = async () => ({
    exitCode: 1,
    durationMs: 1,
    output: `${'x'.repeat(400)}\nno such service: api`,
  });
  assert.equal(await scanLogs(db.pool, 'shop', '/x', failing, new Date('2026-10-18T10:00:00Z')), null);
  assert.equal(db.events.length, 0);
  assert.equal(db.bugs.length, 0);
  assert.equal(db.status.get('shop')?.logError?.length, 300);
  assert.equal(db.status.get('shop')?.logsScannedAt, null, 'Zeitpunkt rückt nicht vor');
  const thrown: CommandExecutor = async () => {
    throw new Error('spawn docker ENOENT');
  };
  await scanLogs(db.pool, 'shop', '/x', thrown, new Date('2026-10-18T10:05:00Z'));
  assert.equal(db.status.get('shop')?.logError, 'spawn docker ENOENT');
  const now = new Date('2026-10-18T10:10:00Z');
  await scanLogs(
    db.pool,
    'shop',
    '/x',
    logsExecutor(() => ''),
    now,
  );
  assert.equal(db.status.get('shop')?.logError, null);
  assert.equal(db.status.get('shop')?.logsScannedAt, now);
});

test('Ein Log-Ereignis nach einem behobenen Bug öffnet diesen als Regression wieder', async () => {
  const db = new FakeProductionDb({ logServices: ['api'] });
  let output = Array.from({ length: 3 }, () => stamped('2026-10-18T09:50:00Z', 'ERROR Kasse kaputt 1')).join('\n');
  const execute = logsExecutor(() => output);
  await scanLogs(db.pool, 'shop', '/x', execute, new Date('2026-10-18T10:00:00Z'));
  assert.equal(db.bugs.length, 1);
  db.bugs[0]!.status = 'fixed';
  output = stamped('2026-10-18T10:05:00Z', 'ERROR Kasse kaputt 2');
  await scanLogs(db.pool, 'shop', '/x', execute, new Date('2026-10-18T10:15:00Z'));
  assert.equal(db.bugs.length, 1, 'kein neuer Bug');
  assert.equal(db.bugs[0]!.status, 'open');
  assert.match(db.bugs[0]!.fixNotes, /Regression/);
  assert.equal(db.events[0]!.count, 4);
});

test('Ab 50 gleichen Log-Fehlern in einer Stunde ist der Bug kritisch', async () => {
  const db = new FakeProductionDb({ logServices: ['api'] });
  const output = Array.from({ length: 50 }, (_, index) => `api-1  | ERROR timeout ${index}`).join('\n');
  await scanLogs(
    db.pool,
    'shop',
    '/x',
    logsExecutor(() => output),
    new Date('2026-10-18T10:00:00Z'),
  );
  assert.equal(db.bugs[0]!.severity, 'critical');
});

test('Zeilen mit Ausschlussmuster erzeugen kein Ereignis', async () => {
  const db = new FakeProductionDb({ logServices: ['api'], ignore: ['favicon.ico'] });
  const execute: CommandExecutor = async () => ({
    exitCode: 0,
    durationMs: 1,
    output: 'api-1  | ERROR GET /favicon.ico 500',
  });
  await scanLogs(db.pool, 'shop', '/projects/shop', execute);
  assert.equal(db.events.length, 0);
  assert.equal(db.bugs.length, 0);
});

test('Nach erfolgreichem Deploy wird der Deploy festgehalten und ein Log-Scan angestoßen', async () => {
  const db = new FakeProductionDb({ logServices: ['api'], deployCommands: [['docker', 'compose', 'up', '-d']] });
  db.orders.push({
    id: 'o-1',
    project: 'shop',
    title: 'Neu',
    status: 'done',
    bugId: null,
    autoRun: false,
    completedAt: new Date(),
  });
  const commands: string[] = [];
  const execute: CommandExecutor = async (command) => (
    commands.push(command.join(' ')),
    {
      exitCode: 0,
      durationMs: 1,
      // Dreimal derselbe Fehler: erreicht die Schwelle für einen Bug.
      output: command.includes('logs') ? 'api-1  | ERROR boom after deploy\n'.repeat(3) : '',
    }
  );
  assert.equal(await deployProject(db.pool, 'shop', '/projects/shop', execute), true);
  assert.equal(commands[0], 'docker compose up -d');
  assert.match(commands[1]!, /^docker compose logs --timestamps --since \d{4}-\d\d-\d\dT[\d:.]+Z --no-color api$/);
  assert.equal(commands.length, 2);
  assert.equal(db.deploys.length, 1);
  assert.deepEqual(db.deploys[0]!.orderIds, ['o-1']);
  assert.equal(db.bugs.length, 1);
  assert.deepEqual((db.events[0]!.deploySuspect as { orders: unknown[] }).orders, [{ id: 'o-1', title: 'Neu' }]);
});

test('Ohne Log-Dienste kein Scan; ein zweiter Scan kurz danach liest ab dem letzten Scan', async () => {
  const commands: string[][] = [];
  const execute = logsExecutor(() => '', commands);
  const empty = new FakeProductionDb();
  assert.equal(await scanLogs(empty.pool, 'shop', '/x', execute), null);
  assert.equal(commands.length, 0);
  assert.equal(empty.status.get('shop'), undefined, 'kein Eintrag in production_status');
  const db = new FakeProductionDb({ logServices: ['api'] });
  await scanLogs(db.pool, 'shop', '/x', execute, new Date('2026-10-18T10:00:00Z'));
  await scanLogs(db.pool, 'shop', '/x', execute, new Date('2026-10-18T10:01:30Z'));
  assert.equal(commands[1]![5], '2026-10-18T10:00:00.000Z');
});

test('Der periodische Takt startet den Log-Scan nur für Projekte mit Log-Diensten', async () => {
  const db = new FakeProductionDb({ logServices: ['api'] });
  db.addProject({ slug: 'ohne', name: 'Ohne' });
  const commands: string[][] = [];
  new ProductionMonitor(
    db.pool,
    logsExecutor(() => '', commands),
    healthy,
  ).tick([
    { slug: 'shop', cwd: '/shop' },
    { slug: 'ohne', cwd: '/ohne' },
  ]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(commands.length, 1);
  assert.equal(commands[0]![2], 'logs');
  assert.ok(db.status.get('shop')?.logsScannedAt);
  assert.equal(db.status.get('ohne')?.logsScannedAt ?? null, null);
});

test('Aufbewahrung: Ereignisse, Verlauf und Deploys älter als die Frist des Projekts werden gelöscht', async () => {
  const statements: string[] = [];
  await purgeProductionData({ query: async (sql: string) => (statements.push(sql), { rows: [] }) } as never);
  assert.equal(statements.length, 3);
  for (const [statement, table] of statements.map((sql, index) => [
    sql,
    ['production_events', 'production_event_buckets', 'production_deploys'][index]!,
  ])) {
    assert.match(statement!, new RegExp(`DELETE FROM ${table}`));
    assert.match(statement!, /make_interval\(days => p\.production_retention_days\)/);
  }
});

/** Wie Postgres: NUL-Bytes in Text werden abgelehnt; zusätzlich scheitert ein Ereignis mit „kaputt“. */
function strictPool(db: FakeProductionDb) {
  const base = db.pool;
  const query = async (sql: string, values: unknown[] = []) => {
    if (values.some((value) => typeof value === 'string' && value.includes('\u0000')))
      throw new Error('invalid byte sequence for encoding "UTF8": 0x00');
    if (sql.includes('INSERT INTO production_events') && values.some((value) => String(value).includes('kaputt')))
      throw new Error('Speichern gescheitert');
    return base.query(sql, values);
  };
  return { query, connect: async () => ({ query, release: () => undefined }) } as unknown as typeof base;
}

test('Log-Scan: NUL-Bytes werden entfernt, der Zeitstempel rückt nach erfolgreicher Verarbeitung vor', async () => {
  const db = new FakeProductionDb({ logServices: ['api'] });
  const output = 'api-1  | ERROR binär \u0000 Daten\napi-1  | ERROR anderer Fehler';
  const execute: CommandExecutor = async () => ({ exitCode: 0, durationMs: 1, output });
  const now = new Date('2026-10-20T10:00:00Z');
  assert.deepEqual(await scanLogs(strictPool(db), 'shop', '/x', execute, now), { events: 2, occurrences: 2 });
  assert.equal(db.events.length, 2);
  assert.equal(db.status.get('shop')?.logsScannedAt, now);
  assert.equal(db.status.get('shop')?.logError, null);
});

test('Log-Scan: ein gescheitertes Ereignis verwirft die übrigen nicht und hält den Zeitstempel an', async () => {
  const db = new FakeProductionDb({ logServices: ['api'] });
  const output = 'api-1  | ERROR kaputt\napi-1  | ERROR gut';
  const execute: CommandExecutor = async () => ({ exitCode: 0, durationMs: 1, output });
  await assert.rejects(scanLogs(strictPool(db), 'shop', '/x', execute), /Speichern gescheitert/);
  assert.equal(db.events.length, 1);
  assert.equal(db.status.get('shop')?.logsScannedAt ?? null, null);
  assert.match(db.status.get('shop')?.logError ?? '', /^Verarbeitung: Speichern gescheitert/);
});
