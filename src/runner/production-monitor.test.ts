import assert from 'node:assert/strict';
import test from 'node:test';
import type { CommandExecutor } from '../core/command.js';
import type { PushMessage } from '../core/push.js';
import { deployProject } from './deploy.js';
import { FakeProductionDb } from './production-fake-db.test.js';
import {
  checkHealth,
  evaluateAlerts,
  type Fetcher,
  healthUrlError,
  nextHealth,
  parseComposeLogs,
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
  const result = await scanLogs(db.pool, 'shop', '/projects/shop', execute);
  assert.deepEqual(result, { events: 1, occurrences: 10 });
  assert.deepEqual(commands[0], ['docker', 'compose', 'logs', '--since', '15m', '--no-color', 'api']);
  assert.equal(db.bugs.length, 1);
  assert.equal(db.events[0]!.count, 10);
  assert.equal(db.events[0]!.source, 'logs');
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
    { exitCode: 0, durationMs: 1, output: command.includes('logs') ? 'api-1  | ERROR boom after deploy' : '' }
  );
  assert.equal(await deployProject(db.pool, 'shop', '/projects/shop', execute), true);
  assert.deepEqual(commands, ['docker compose up -d', 'docker compose logs --since 15m --no-color api']);
  assert.equal(db.deploys.length, 1);
  assert.deepEqual(db.deploys[0]!.orderIds, ['o-1']);
  assert.equal(db.bugs.length, 1);
  assert.deepEqual((db.events[0]!.deploySuspect as { orders: unknown[] }).orders, [{ id: 'o-1', title: 'Neu' }]);
});

test('Ohne Log-Dienste kein Scan; ein zweiter Scan kurz danach liest nur die neuen Sekunden', async () => {
  const commands: string[][] = [];
  const execute: CommandExecutor = async (command) => (
    commands.push(command),
    { exitCode: 0, durationMs: 1, output: '' }
  );
  assert.equal(await scanLogs(new FakeProductionDb().pool, 'shop', '/x', execute), null);
  assert.equal(commands.length, 0);
  const db = new FakeProductionDb({ logServices: ['api'] });
  await scanLogs(db.pool, 'shop', '/x', execute, new Date('2026-10-18T10:00:00Z'));
  await scanLogs(db.pool, 'shop', '/x', execute, new Date('2026-10-18T10:01:30Z'));
  assert.equal(commands[1]![4], '90s');
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
