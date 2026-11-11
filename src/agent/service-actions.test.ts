import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { CommandExecutor } from '../core/command.js';
import { buildChatPrompt } from './chat.js';
import { PERMISSION_GROUPS, commandHelp } from '../core/permission-rules.js';
import {
  composeFileFor,
  runServiceAction,
  runServiceMarkers,
  serviceCommand,
  serviceResultsSection,
  type ServiceContext,
} from './service-actions.js';
import { parseServiceMarker, parseServiceRequest, type ServiceRequest, sinceSeconds } from './service-request.js';

const directories: string[] = [];
after(async () => {
  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
});

/** Projekt mit compose.yaml im Temp-Ordner. */
async function project(): Promise<string> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'service-actions-')));
  directories.push(directory);
  await writeFile(join(directory, 'compose.yaml'), 'services:\n  api:\n    image: x\n  web:\n    image: y\n');
  return directory;
}

/** Fake für docker compose: kennt die Dienste api und web, merkt sich jeden Aufruf (ohne „docker compose -f <datei>“). */
function fakeDocker(options: { config?: string; output?: string; exitCode?: number } = {}) {
  const calls: { command: string[]; cwd: string; env?: NodeJS.ProcessEnv }[] = [];
  const execute: CommandExecutor = async (command, cwd, settings) => {
    calls.push({ command, cwd, env: settings?.env });
    if (command.includes('--services')) return { exitCode: 0, durationMs: 1, output: 'api\nweb\n' };
    if (command.includes('--format'))
      return { exitCode: 0, durationMs: 1, output: options.config ?? '{"services":{}}' };
    return { exitCode: options.exitCode ?? 0, durationMs: 1, output: options.output ?? 'ok' };
  };
  return { calls, execute, ran: () => calls.map((call) => call.command.slice(4).join(' ')) };
}

const context = (cwd: string, overrides: Partial<ServiceContext> = {}): ServiceContext => ({
  cwd,
  role: 'assistant',
  commands: ['services'],
  installRoot: '/nicht/aideation',
  ...overrides,
});
const request = (input: Parameters<typeof parseServiceRequest>[0]): ServiceRequest => {
  const parsed = parseServiceRequest(input);
  assert.notEqual(typeof parsed, 'string', String(parsed));
  return parsed as ServiceRequest;
};

test('services.restart: Worker prüft Dienst und Konfiguration, startet neu und liefert das Ergebnis', async () => {
  const cwd = await project();
  const docker = fakeDocker({ output: 'Container api Restarting\nContainer api Started' });
  const result = await runServiceAction(request({ action: 'restart', services: ['api'] }), {
    ...context(cwd),
    execute: docker.execute,
  });
  assert.equal(result, 'services.restart api: erledigt\nContainer api Restarting\nContainer api Started');
  assert.deepEqual(docker.ran(), ['config --services', 'config --format json', 'restart api']);
  // Argumentliste mit der Compose-Datei im Projekt, im Projektordner, mit gefiltertem Environment.
  assert.deepEqual(docker.calls[2]!.command.slice(0, 4), ['docker', 'compose', '-f', join(cwd, 'compose.yaml')]);
  assert.equal(docker.calls[2]!.cwd, cwd);
  assert.equal(docker.calls[2]!.env?.DEV_LOG_DATABASE_URL, undefined);
});

test('services.up: Compose-Datei ausserhalb des Projektordners wird abgelehnt, ohne docker aufzurufen', async () => {
  const cwd = await project();
  const outside = await realpath(await mkdtemp(join(tmpdir(), 'service-outside-')));
  directories.push(outside);
  await writeFile(join(outside, 'compose.yml'), 'services:\n  evil:\n    image: x\n');
  await symlink(join(outside, 'compose.yml'), join(cwd, 'link.yml'));
  const docker = fakeDocker();
  // Über einen Link im Projekt, der nach draussen zeigt.
  assert.match(
    await runServiceAction(request({ action: 'services.up', file: 'link.yml' }), {
      ...context(cwd),
      execute: docker.execute,
    }),
    /abgelehnt – Die Compose-Datei link\.yml liegt ausserhalb des Projektordners/,
  );
  // Absolute Pfade und „..“ lässt schon die Anfrage nicht zu.
  for (const file of [join(outside, 'compose.yml'), '../service-outside/compose.yml', 'a/../../x.yml']) {
    assert.match(String(parseServiceRequest({ action: 'services.up', file })), /relativ zum Projektordner/, file);
  }
  assert.match(String(parseServiceMarker(`services.up --build --file=${join(outside, 'compose.yml')}`)), /relativ/);
  assert.deepEqual(docker.calls, []);
});

test('services.up: Projekt ohne Compose-Datei bzw. unsichere Konfiguration wird abgelehnt', async () => {
  const empty = await realpath(await mkdtemp(join(tmpdir(), 'service-empty-')));
  directories.push(empty);
  assert.deepEqual(composeFileFor(request({ action: 'services.up' }), empty), {
    problem:
      'Im Projektordner liegt keine Compose-Datei (compose.yaml, compose.yml, docker-compose.yaml, docker-compose.yml).',
  });
  const cwd = await project();
  const docker = fakeDocker({ config: '{"services":{"api":{"volumes":[{"type":"bind","source":"/"}]}}}' });
  const result = await runServiceAction(request({ action: 'services.up', build: true }), {
    ...context(cwd),
    execute: docker.execute,
  });
  assert.match(
    result,
    /^services\.up \(mit Build\): abgelehnt – Dienst "api" bindet \/ außerhalb des Projektordners ein/,
  );
  assert.deepEqual(docker.ran(), ['config --services', 'config --format json']);
});

test('Dienst-Aktionen: unbekannte Dienste, Rolle, fehlendes Recht und AIdeation selbst werden abgelehnt', async () => {
  const cwd = await project();
  const docker = fakeDocker();
  const run = (input: Parameters<typeof parseServiceRequest>[0], overrides: Partial<ServiceContext> = {}) =>
    runServiceAction(request(input), { ...context(cwd, overrides), execute: docker.execute });
  assert.match(await run({ action: 'restart', services: ['db'] }), /unbekannte Dienste db \(vorhanden: api, web\)/);
  assert.match(await run({ action: 'restart' }, { commands: [] }), /nicht freigegeben/);
  assert.match(await run({ action: 'status' }, { role: 'analyst' }), /Rolle „analyst“ nicht erlaubt/);
  assert.match(await run({ action: 'status' }, { role: 'documenter' }), /Rolle „documenter“ nicht erlaubt/);
  assert.match(await run({ action: 'restart' }, { role: 'routine' }), /nur ansehen/);
  assert.match(await run({ action: 'stop', services: ['api'] }, { installRoot: cwd }), /AIdeation selbst/);
  assert.match(await run({ action: 'up' }, { installRoot: cwd }), /AIdeation selbst/);
  // Nur die eine Prüfung der Dienstnamen lief; nichts wurde gestartet oder gestoppt.
  assert.deepEqual(docker.ran(), ['config --services']);
  // Lesen ist auch für Routinen und im Installationsordner erlaubt.
  assert.match(await run({ action: 'status' }, { role: 'routine', installRoot: cwd }), /^services\.status: erledigt/);
});

test('services.logs: Zeilenlimit und Zeitraum als feste Argumente, Ausgabe maskiert und gekürzt', async () => {
  const cwd = await project();
  process.env.SERVICE_ACTIONS_TEST_TOKEN = 'sehr-geheimes-token';
  try {
    const docker = fakeDocker({ output: `api | token=sehr-geheimes-token\n${'x'.repeat(9_000)}` });
    const result = await runServiceAction(request({ action: 'logs', services: 'api web', lines: 50, since: '15m' }), {
      ...context(cwd),
      execute: docker.execute,
    });
    assert.deepEqual(docker.ran(), ['config --services', 'logs --no-color --timestamps --tail=50 --since=15m api web']);
    assert.match(result, /^services\.logs api web \(50 Zeilen, seit 15m\): erledigt\n\[gekürzt/);
    assert.doesNotMatch(result, /sehr-geheimes-token/);
    assert.ok(result.length < 8_200);
  } finally {
    delete process.env.SERVICE_ACTIONS_TEST_TOKEN;
  }
  assert.deepEqual(serviceCommand(request({ action: 'logs' }), '/p/compose.yaml').slice(4), [
    'logs',
    '--no-color',
    '--timestamps',
    '--tail=200',
  ]);
});

test('Anfragen: Aktion, Dienstnamen, Zeilenlimit, Zeitraum und Build werden streng geprüft', () => {
  assert.deepEqual(parseServiceMarker('services.logs api --lines=100 --since=2h'), {
    action: 'services.logs',
    services: ['api'],
    lines: 100,
    since: '2h',
  });
  assert.deepEqual(parseServiceMarker('up web --build'), { action: 'services.up', services: ['web'], build: true });
  for (const [line, reason] of [
    ['services.exec api', /Unbekannte Dienst-Aktion/],
    ['services.restart api;rm', /kein gültiger Dienstname/],
    ['services.restart ../x', /kein gültiger Dienstname/],
    ['services.logs api --lines=0', /lines muss/],
    ['services.logs api --lines=1001', /lines muss/],
    ['services.logs api --since=2d', /since muss/],
    ['services.logs api --since=25h', /since muss/],
    ['services.restart api --lines=5', /nur bei services\.logs/],
    ['services.restart api --build', /nur bei services\.up/],
    ['services.up -v', /Unbekannte Option/],
  ] as const) {
    assert.match(String(parseServiceMarker(line)), reason, line);
  }
  assert.equal(sinceSeconds('15m'), 900);
  assert.equal(sinceSeconds('0s'), null);
});

test('Projektsperre wird auch bei einem Fehler des Befehls freigegeben', async () => {
  const cwd = await project();
  let fail = true;
  const execute: CommandExecutor = async (command) => {
    if (command.includes('--services')) return { exitCode: 0, durationMs: 1, output: 'api' };
    if (fail && command.includes('stop')) {
      fail = false;
      throw new Error('docker nicht erreichbar');
    }
    return { exitCode: 0, durationMs: 1, output: 'gestoppt' };
  };
  const stop = request({ action: 'stop', services: ['api'] });
  assert.match(
    await runServiceAction(stop, { ...context(cwd), execute }),
    /abgelehnt – Fehler: docker nicht erreichbar/,
  );
  // Der nächste Aufruf unter derselben Sperre läuft durch, statt zu hängen.
  assert.equal(await runServiceAction(stop, { ...context(cwd), execute }), 'services.stop api: erledigt\ngestoppt');
});

test('Marker der Claude-CLI: Worker führt sie aus, das Ergebnis steht im Chat', async () => {
  const cwd = await project();
  const docker = fakeDocker({ output: 'Container api Started' });
  const { text, results } = await runServiceMarkers(
    'Ich starte die API neu.\n@@SERVICES: services.restart api\n@@SERVICES: services.drop api',
    { ...context(cwd), execute: docker.execute },
  );
  assert.equal(text, 'Ich starte die API neu.');
  assert.deepEqual(results, [
    'services.restart api: erledigt\nContainer api Started',
    'services.drop api: abgelehnt – Unbekannte Dienst-Aktion „services.drop“ (erlaubt: services.status, services.logs, services.restart, services.up, services.stop).',
  ]);
  assert.equal(
    serviceResultsSection(results.slice(0, 1)),
    '## Dienst-Aktionen\n- services.restart api: erledigt\n\n```text\nContainer api Started\n```',
  );
  assert.equal(serviceResultsSection([]), '');
  // Höchstens fünf Aktionen je Antwort.
  const many = await runServiceMarkers(Array.from({ length: 6 }, () => '@@SERVICES: services.status').join('\n'), {
    ...context(cwd),
    execute: docker.execute,
  });
  assert.match(many.results[5]!, /höchstens 5 Dienst-Aktionen/);
});

test('launchctl steht in keiner Standard-Rechteregel und keinem Prompt (permission-rules.ts, chat.ts)', async () => {
  for (const file of ['../core/permission-rules.ts', 'chat.ts', 'ollama-prompts.ts']) {
    const source = await readFile(new URL(`./${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /launchctl|kickstart/, file);
  }
  for (const group of PERMISSION_GROUPS) {
    for (const rule of group.rules) {
      assert.doesNotMatch(`${rule} ${commandHelp(rule)}`, /launchctl|docker compose|Bash\(docker/, rule);
    }
  }
  const prompt = buildChatPrompt([{ role: 'user', content: 'Starte die API neu' }]);
  assert.doesNotMatch(prompt, /launchctl|~\/Library|lsof|docker compose/);
  assert.match(prompt, /services\.restart/);
  assert.match(prompt, /services\.logs/);
});
