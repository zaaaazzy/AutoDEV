import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { CommandExecutor } from '../core/command.js';
import { BACKUP_DIRECTORY, executeTool, type ToolContext } from './ollama-tools.js';
import type { SqlClientFactory } from './tool-sql.js';

const directories: string[] = [];
after(async () => {
  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
});

/** Projekt im Temp-Ordner; alles, was die Werkzeuge schreiben, bleibt darin. */
async function project(): Promise<string> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'ollama-tools-')));
  directories.push(directory);
  await writeFile(join(directory, 'a.txt'), 'alt\n');
  await writeFile(join(directory, '.env'), 'SECRET=1\n');
  await mkdir(join(directory, 'src'));
  await writeFile(join(directory, 'src', 'app.ts'), 'export const wert = 1;\n');
  await mkdir(join(directory, 'node_modules'));
  return directory;
}

/** Fake für Befehle: führt nie etwas aus, merkt sich nur Aufruf und Optionen. */
function recorder(output = (command: string[]) => `ran ${command.join(' ')}`, exitCode = 0) {
  const calls: { command: string[]; options: Parameters<CommandExecutor>[2] }[] = [];
  const execute: CommandExecutor = async (command, _cwd, options) => {
    calls.push({ command, options });
    return { exitCode, durationMs: 1, output: output(command) };
  };
  return { calls, execute };
}

const context = (cwd: string, overrides: Partial<ToolContext> = {}): ToolContext => ({
  cwd,
  canWrite: true,
  files: { create: true, edit: true, scopes: [] },
  changed: new Set(),
  backupRoot: join(cwd, BACKUP_DIRECTORY, 'lauf'),
  timeoutMs: 1000,
  execute: recorder().execute,
  ...overrides,
});
const call = (name: string, args: Record<string, unknown> = {}) => ({ function: { name, arguments: args } });

test('list_files: sortiert, Ordner mit „/“, ohne gesperrte Ordner und Geheimnisse', async () => {
  const cwd = await project();
  assert.equal(await executeTool(context(cwd), call('list_files', {})), 'a.txt\nsrc/');
  assert.equal(await executeTool(context(cwd), call('list_files', { path: 'src' })), 'app.ts');
  await mkdir(join(cwd, 'leer'));
  assert.equal(await executeTool(context(cwd), call('list_files', { path: 'leer' })), '(leer)');
  assert.match(await executeTool(context(cwd), call('list_files', { path: '..' })), /^Fehler: .*außerhalb/);
});

test('read_file: ab Startzeile, höchstens 300 Zeilen, grosse Dateien abgelehnt', async () => {
  const cwd = await project();
  await writeFile(join(cwd, 'lang.txt'), Array.from({ length: 450 }, (_, index) => `Zeile ${index + 1}`).join('\n'));
  const head = await executeTool(context(cwd), call('read_file', { path: 'lang.txt' }));
  assert.match(head, /^Zeile 1\n/);
  assert.match(head, /Zeile 300\n\[weitere Zeilen ab 301\]$/);
  const tail = await executeTool(context(cwd), call('read_file', { path: 'lang.txt', start_line: 400 }));
  assert.match(tail, /^Zeile 400\n[\s\S]*Zeile 450$/);
  // Ungültige oder zu kleine Startzeilen beginnen bei 1.
  for (const start of ['abc', 0, -5]) {
    assert.match(await executeTool(context(cwd), call('read_file', { path: 'a.txt', start_line: start })), /^alt\n$/);
  }
  await writeFile(join(cwd, 'gross.txt'), 'x'.repeat(400_001));
  assert.equal(await executeTool(context(cwd), call('read_file', { path: 'gross.txt' })), 'Datei ist zu groß.');
  assert.match(await executeTool(context(cwd), call('read_file', { path: 'fehlt.txt' })), /existiert nicht/);
  assert.match(await executeTool(context(cwd), call('read_file', {})), /Ungültiger Pfad/);
});

test('read_file: lange Ausgaben werden auf 8000 Zeichen gekürzt', async () => {
  const cwd = await project();
  await writeFile(join(cwd, 'breit.txt'), 'y'.repeat(9_000));
  const output = await executeTool(context(cwd), call('read_file', { path: 'breit.txt' }));
  assert.match(output, /\n\[gekürzt, 1000 Zeichen\]$/);
  assert.equal(output.indexOf('\n'), 8_000);
});

test('search_text: Suchtext mindestens zwei Zeichen, Treffer relativ zum Projekt', async () => {
  const cwd = await project();
  assert.equal(await executeTool(context(cwd), call('search_text', { query: 'w' })), 'Suchtext zu kurz.');
  assert.equal(await executeTool(context(cwd), call('search_text', { query: 42 })), 'Suchtext zu kurz.');
  assert.equal(
    await executeTool(context(cwd), call('search_text', { query: 'wert' })),
    'src/app.ts:1: export const wert = 1;',
  );
  assert.equal(
    await executeTool(context(cwd), call('search_text', { query: 'wert', path: 'src' })),
    'src/app.ts:1: export const wert = 1;',
  );
  assert.equal(await executeTool(context(cwd), call('search_text', { query: 'SECRET' })), 'Keine Treffer.');
});

test('write_file: nur mit Schreibrecht, gültigem Inhalt und erlaubtem Pfad; legt Ordner an und sichert', async () => {
  const cwd = await project();
  const readOnly = context(cwd, { canWrite: false });
  assert.equal(
    await executeTool(readOnly, call('write_file', { path: 'b.txt', content: 'x' })),
    'Schreiben ist für diese Rolle nicht erlaubt.',
  );
  const dev = context(cwd);
  for (const content of [undefined, 42, 'x'.repeat(400_001)]) {
    assert.equal(await executeTool(dev, call('write_file', { path: 'b.txt', content })), 'Ungültiger Inhalt.');
  }
  assert.match(await executeTool(dev, call('write_file', { path: '.env', content: 'x' })), /nicht erlaubt/);
  assert.equal(
    await executeTool(dev, call('write_file', { path: 'neu/tief/b.txt', content: 'hallo' })),
    'neu/tief/b.txt geschrieben (5 Zeichen).',
  );
  assert.equal(await readFile(join(cwd, 'neu', 'tief', 'b.txt'), 'utf8'), 'hallo');
  assert.match(await executeTool(dev, call('write_file', { path: 'a.txt', content: 'neu\n' })), /geschrieben/);
  assert.equal(await readFile(join(dev.backupRoot, 'a.txt'), 'utf8'), 'alt\n', 'Original gesichert');
  assert.deepEqual([...dev.changed].sort(), ['a.txt', 'neu/tief/b.txt']);
});

test('write_file und replace_in_file: Dateirechte des Agents (Anlegen, Ändern, Ordner)', async () => {
  const cwd = await project();
  const createOnly = context(cwd, { files: { create: true, edit: false, scopes: ['src'] } });
  assert.match(await executeTool(createOnly, call('write_file', { path: 'src/neu.ts', content: 'x' })), /geschrieben/);
  assert.match(
    await executeTool(createOnly, call('write_file', { path: 'a.txt', content: 'x' })),
    /ausserhalb der erlaubten Ordner/,
  );
  assert.match(
    await executeTool(createOnly, call('replace_in_file', { path: 'src/app.ts', old_text: '1', new_text: '2' })),
    /ändern ist für diesen Agent nicht freigegeben/,
  );
  assert.equal(await readFile(join(cwd, 'src', 'app.ts'), 'utf8'), 'export const wert = 1;\n');
});

test('replace_in_file: genau eine Fundstelle, Ersatztext wörtlich, mit Sicherung', async () => {
  const cwd = await project();
  const readOnly = context(cwd, { canWrite: false });
  assert.equal(
    await executeTool(readOnly, call('replace_in_file', { path: 'a.txt', old_text: 'alt', new_text: 'neu' })),
    'Schreiben ist für diese Rolle nicht erlaubt.',
  );
  const dev = context(cwd);
  for (const args of [
    { path: 'a.txt', old_text: '', new_text: 'x' },
    { path: 'a.txt', old_text: 'alt' },
    { path: 'a.txt', old_text: 1, new_text: 'x' },
  ]) {
    assert.equal(await executeTool(dev, call('replace_in_file', args)), 'old_text und new_text müssen Texte sein.');
  }
  await writeFile(join(cwd, 'doppelt.txt'), 'x x');
  assert.equal(
    await executeTool(dev, call('replace_in_file', { path: 'doppelt.txt', old_text: 'x', new_text: 'y' })),
    'old_text kommt 2-mal vor, erwartet genau 1.',
  );
  assert.match(
    await executeTool(dev, call('replace_in_file', { path: 'fehlt.txt', old_text: 'a', new_text: 'b' })),
    /existiert nicht/,
  );
  // „$&“ im Ersatztext bleibt wörtlich (kein Regex-Ersatzmuster).
  assert.equal(
    await executeTool(dev, call('replace_in_file', { path: 'a.txt', old_text: 'alt', new_text: 'neu $& $1' })),
    'Ersetzt.',
  );
  assert.equal(await readFile(join(cwd, 'a.txt'), 'utf8'), 'neu $& $1\n');
  assert.equal(await readFile(join(dev.backupRoot, 'a.txt'), 'utf8'), 'alt\n');
  assert.deepEqual([...dev.changed], ['a.txt']);
});

test('run_command: Rolle, Geheimnisse, Agent-Freigaben und feste Liste werden geprüft', async () => {
  const cwd = await project();
  const { calls, execute } = recorder();
  assert.equal(
    await executeTool(context(cwd, { canWrite: false, execute }), call('run_command', { command: 'npm test' })),
    'Befehle sind für diese Rolle nicht erlaubt.',
  );
  const dev = context(cwd, { execute });
  assert.match(await executeTool(dev, call('run_command', { command: 'git log -- .env' })), /Geheimnisse/);
  assert.match(await executeTool(dev, call('run_command', { command: 'rm -rf /' })), /Datei-Werkzeugen/);
  assert.match(await executeTool(dev, call('run_command', {})), /^Befehl nicht erlaubt/, 'fehlender Befehl');
  const limited = context(cwd, { execute, commands: ['Bash(npm test:*)'] });
  assert.match(
    await executeTool(limited, call('run_command', { command: 'git status' })),
    /„git status“ ist für diesen Agent nicht freigegeben/,
  );
  assert.equal(
    await executeTool(limited, call('run_command', { command: '  npm test  ' })),
    'Exit-Code 0\nran npm test',
  );
  // docker nie per Shell, auch nicht mit canManageServices: Dienste nur über service_action.
  for (const tools of [dev, context(cwd, { execute, canManageServices: true })]) {
    assert.match(
      await executeTool(tools, call('run_command', { command: 'docker compose ps' })),
      /service_action|services\./,
    );
  }
  assert.deepEqual(
    calls.map((entry) => entry.command.join(' ')),
    ['npm test'],
  );
});

test('run_command: npm install ohne Skripte, ohne DEV_LOG_-Variablen, mit Zeitlimit und Maskierung', async () => {
  const cwd = await project();
  process.env.DEV_LOG_TEST_SECRET = 'nicht-weitergeben';
  process.env.OLLAMA_TOOLS_TEST_TOKEN = 'geheimes-token';
  try {
    const { calls, execute } = recorder(() => `token=geheimes-token\n${'z'.repeat(9_000)}`, 3);
    const output = await executeTool(
      context(cwd, { execute, timeoutMs: 60 * 60_000 }),
      call('run_command', { command: 'npm install' }),
    );
    assert.deepEqual(calls[0]!.command, ['npm', 'install', '--ignore-scripts']);
    assert.equal(calls[0]!.options?.timeoutMs, 10 * 60_000, 'höchstens zehn Minuten');
    assert.equal(calls[0]!.options?.env?.DEV_LOG_TEST_SECRET, undefined);
    assert.match(output, /^Exit-Code 3\n/);
    assert.doesNotMatch(output, /geheimes-token/);
    assert.ok(output.length <= 8_000 + 40, 'Ausgabe gekürzt');
  } finally {
    delete process.env.DEV_LOG_TEST_SECRET;
    delete process.env.OLLAMA_TOOLS_TEST_TOKEN;
  }
});

test('service_action: der Worker prüft die Konfiguration und startet den Dienst neu', async () => {
  const cwd = await project();
  await writeFile(join(cwd, 'compose.yaml'), 'services:\n  app:\n    image: x\n');
  const ran: string[] = [];
  const execute: CommandExecutor = async (command) => {
    ran.push(command.slice(4).join(' '));
    if (command.includes('--services')) return { exitCode: 0, durationMs: 1, output: 'app\n' };
    if (command.includes('--format')) return { exitCode: 0, durationMs: 1, output: '{"services":{"app":{}}}' };
    return { exitCode: 0, durationMs: 1, output: 'Container app Started' };
  };
  const tools = context(cwd, { execute, serviceRole: 'assistant', commands: ['services'] });
  assert.equal(
    await executeTool(tools, call('service_action', { action: 'services.restart', services: 'app' })),
    'services.restart app: erledigt\nContainer app Started',
  );
  assert.deepEqual(ran, ['config --services', 'config --format json', 'restart app']);
  // Ohne Dienst-Rolle gibt es das Werkzeug nicht; ungültige Anfragen erreichen den Worker nicht.
  assert.match(
    await executeTool(context(cwd, { execute }), call('service_action', { action: 'services.status' })),
    /nicht freigegeben/,
  );
  assert.match(
    await executeTool(tools, call('service_action', { action: 'services.exec' })),
    /^Abgelehnt: Unbekannte Dienst-Aktion/,
  );
  assert.match(
    await executeTool(tools, call('service_action', { action: 'services.logs', lines: 5000 })),
    /^Abgelehnt: lines muss/,
  );
  assert.equal(ran.length, 3);
});

test('run_sql: nur mit Freigabe, Schreibrecht, Datenbank und gültigem SQL – über einen Fake-Client', async () => {
  const cwd = await project();
  const sent: string[] = [];
  const sqlClient: SqlClientFactory = () => ({
    connect: async () => undefined,
    query: async (text: string) => {
      sent.push(text);
      return { command: 'SELECT', rowCount: 1, rows: [{ eins: 1 }] };
    },
    end: async () => undefined,
  });
  const databaseUrl = 'postgresql://localhost/projekt';
  const ok = context(cwd, { databaseUrl, sqlClient });
  assert.match(
    await executeTool(
      context(cwd, { databaseUrl, sqlClient, commands: ['Bash(npm test:*)'] }),
      call('run_sql', { sql: 'select 1' }),
    ),
    /nicht freigegeben/,
  );
  assert.match(
    await executeTool(context(cwd, { databaseUrl, sqlClient, canWrite: false }), call('run_sql', { sql: 'select 1' })),
    /kein Datenbank-Zugang/,
  );
  assert.match(
    await executeTool(context(cwd, { sqlClient }), call('run_sql', { sql: 'select 1' })),
    /kein Datenbank-Zugang/,
  );
  for (const sql of [undefined, '   ', 'x'.repeat(20_001)]) {
    assert.equal(await executeTool(ok, call('run_sql', { sql })), 'sql muss ein nicht leerer Text sein.');
  }
  assert.equal(sent.length, 0);
  const output = await executeTool(
    context(cwd, { databaseUrl, sqlClient, commands: ['database'] }),
    call('run_sql', { sql: 'select 1 AS eins' }),
  );
  assert.equal(output, 'SELECT: 1 Zeile(n)\n[{"eins":1}]');
  assert.ok(sent.includes('select 1 AS eins'));
});

test('unbekannte Werkzeuge und unerwartete Fehler kommen als Text zurück', async () => {
  const cwd = await project();
  assert.equal(await executeTool(context(cwd), call('delete_everything')), 'Unbekanntes Werkzeug: delete_everything');
  // Auch Fehler, die keine Error-Objekte sind, werden zu Text.
  const broken = context(cwd, {
    databaseUrl: 'postgresql://localhost/projekt',
    sqlClient: () => {
      throw 'Treiber fehlt';
    },
  });
  assert.equal(await executeTool(broken, call('run_sql', { sql: 'select 1' })), 'Fehler: Treiber fehlt');
});

test('run_command: ein scheiternder Executor wird als Ablehnung weitergegeben (Ist-Verhalten)', async () => {
  // executeTool gibt das Promise aus withProjectLock ohne await zurück; der catch-Block greift hier nicht.
  const cwd = await project();
  const crashing = context(cwd, {
    execute: async () => {
      throw new Error('spawn npm ENOENT');
    },
  });
  await assert.rejects(executeTool(crashing, call('run_command', { command: 'npm test' })), /spawn npm ENOENT/);
});
