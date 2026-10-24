import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { chmod, cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { RESTART_EXIT_CODE } from '../runner/system-restart.js';

// Installationsskripte (scripts/install-*.sh, install-worker.ps1) im Probelauf: Dateien schreiben, Dienst nicht
// registrieren. Zugänge stehen nur in der Env-Datei (600), Plist/Unit sind wohlgeformt und enthalten keine Geheimnisse.

const SCRIPTS = join(import.meta.dirname, '..', '..', 'scripts');
const PASSWORD = `a&b<c>"'%$\\x`;
const DATABASE_URL = `postgresql://devlog:${PASSWORD}@localhost:5433/aideation`;
const SECRET_KEY = `schluessel&<>"'%$\\-0123456789`;
const isMac = platform() === 'darwin';
const hasPwsh = spawnSync('pwsh', ['-NoProfile', '-Command', 'exit 0']).status === 0;

/** Kopie der Skripte unter einem Projektpfad mit Sonderzeichen (Leerzeichen, &, <, >, %). */
async function sandbox() {
  const base = await mkdtemp(join(tmpdir(), 'aideation-install-'));
  const root = join(base, 'Projekt & <Test> 100%');
  await cp(SCRIPTS, join(root, 'scripts'), { recursive: true });
  const home = join(base, 'home');
  await mkdir(home);
  return { base, root, home };
}

/** Nur das Nötigste an Umgebung: keine Zugänge des Testlaufs gelangen in die Skripte. */
function run(command: string, args: string[], env: Record<string, string>) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', AIDEATION_INSTALL_DRY_RUN: '1', ...env },
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}`, stderr: result.stderr };
}

const mode = (file: string) => statSync(file).mode & 0o777;

test('macOS-Worker: Plist wohlgeformt, Rechte 600, Zugänge nur in der Env-Datei', { skip: !isMac }, async () => {
  const { root, home } = await sandbox();
  const plist = join(home, 'Library', 'LaunchAgents', 'com.aideation.worker.plist');
  // Alte Plist aus früherer Fassung (world-readable) wird ersetzt, nicht nur überschrieben.
  await mkdir(join(home, 'Library', 'LaunchAgents'), { recursive: true });
  await writeFile(plist, 'alt');
  await chmod(plist, 0o644);

  const result = run('bash', [join(root, 'scripts', 'install-worker.sh')], {
    HOME: home,
    DEV_LOG_DATABASE_URL: DATABASE_URL,
    DEV_LOG_SECRET_KEY: SECRET_KEY,
  });
  assert.equal(result.status, 0, result.output);
  assert.equal(spawnSync('plutil', ['-lint', '-s', plist]).status, 0, 'plutil -lint');
  assert.equal(mode(plist), 0o600);
  const envFile = join(home, '.config', 'aideation', 'worker.env');
  assert.equal(mode(envFile), 0o600);
  assert.equal(mode(join(home, '.config', 'aideation')), 0o700);

  const xml = await readFile(plist, 'utf8');
  assert.doesNotMatch(xml, /devlog:a&|schluessel|DEV_LOG_DATABASE_URL|DEV_LOG_SECRET_KEY/);
  const parsed = JSON.parse(spawnSync('plutil', ['-convert', 'json', '-o', '-', plist], { encoding: 'utf8' }).stdout);
  assert.equal(parsed.WorkingDirectory, root);
  // Node direkt (kein /bin/bash: dem verweigert macOS als Dienst den Zugriff auf externe Laufwerke), Zugänge per --env-file.
  assert.match(parsed.ProgramArguments[0], /\/node$/);
  assert.deepEqual(parsed.ProgramArguments.slice(1, 4), [
    `--env-file=${envFile}`,
    join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
    'src/runner/runner-cli.ts',
  ]);
  assert.deepEqual(parsed.ProgramArguments.slice(-4), ['--all', '--watch', '--limit', '3']);
  assert.ok(!parsed.ProgramArguments.includes('/bin/bash'));

  const lines = (await readFile(envFile, 'utf8')).split('\n');
  assert.ok(lines.includes(`DEV_LOG_DATABASE_URL=${DATABASE_URL}`));
  assert.ok(lines.includes(`DEV_LOG_SECRET_KEY=${SECRET_KEY}`));
  assert.ok(
    !result.output.includes(PASSWORD) && !result.output.includes(SECRET_KEY),
    'keine Geheimnisse in der Ausgabe',
  );
  assert.doesNotMatch(result.stderr, /WARNUNG/);
});

test('macOS-Worker: erneuter Lauf behält Zugänge, ohne Zugang gibt es eine Warnung', { skip: !isMac }, async () => {
  const { root, home } = await sandbox();
  const script = join(root, 'scripts', 'install-worker.sh');
  const envFile = join(home, '.config', 'aideation', 'worker.env');

  const first = run('bash', [script], { HOME: home });
  assert.equal(first.status, 0, first.output);
  assert.match(first.stderr, /WARNUNG: .*Standardpasswort/);
  assert.match(await readFile(envFile, 'utf8'), /^DEV_LOG_DATABASE_URL=postgresql:\/\/devlog:devlog_local_dev@/m);

  assert.equal(run('bash', [script], { HOME: home, DEV_LOG_DATABASE_URL: DATABASE_URL }).status, 0);
  const again = run('bash', [script], { HOME: home });
  assert.equal(again.status, 0, again.output);
  assert.doesNotMatch(again.stderr, /WARNUNG/);
  assert.ok((await readFile(envFile, 'utf8')).split('\n').includes(`DEV_LOG_DATABASE_URL=${DATABASE_URL}`));
});

test('macOS-Wächter: Plist wohlgeformt, Rechte 600, ohne Datenbank-URL', { skip: !isMac }, async () => {
  const { root, home } = await sandbox();
  const result = run('bash', [join(root, 'scripts', 'install-watchdog.sh')], {
    HOME: home,
    DEV_LOG_DATABASE_URL: DATABASE_URL,
    DEV_LOG_PUBLIC_URL: 'https://aideation.example.com/?a=1&b=2',
  });
  assert.equal(result.status, 0, result.output);
  const plist = join(home, 'Library', 'LaunchAgents', 'com.aideation.watchdog.plist');
  assert.equal(spawnSync('plutil', ['-lint', '-s', plist]).status, 0, 'plutil -lint');
  assert.equal(mode(plist), 0o600);
  assert.doesNotMatch(await readFile(plist, 'utf8'), /devlog:a&|DEV_LOG_DATABASE_URL/);
  const envFile = join(home, '.config', 'aideation', 'watchdog.env');
  assert.equal(mode(envFile), 0o600);
  const lines = (await readFile(envFile, 'utf8')).split('\n');
  assert.ok(lines.includes(`DEV_LOG_DATABASE_URL=${DATABASE_URL}`));
  assert.ok(lines.includes('DEV_LOG_PUBLIC_URL=https://aideation.example.com/?a=1&b=2'));
  const parsed = JSON.parse(spawnSync('plutil', ['-convert', 'json', '-o', '-', plist], { encoding: 'utf8' }).stdout);
  assert.deepEqual(parsed.ProgramArguments.slice(1), [
    `--env-file=${envFile}`,
    join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
    'src/runner/watchdog-cli.ts',
  ]);
});

test('Linux-Worker: Unit ohne Geheimnisse, Rechte 600, Sonderzeichen für systemd escapt', async () => {
  const { root, home } = await sandbox();
  const result = run('bash', [join(root, 'scripts', 'install-worker-linux.sh')], {
    HOME: home,
    DEV_LOG_DATABASE_URL: DATABASE_URL,
    DEV_LOG_SECRET_KEY: SECRET_KEY,
  });
  assert.equal(result.status, 0, result.output);
  const unitFile = join(home, '.config', 'systemd', 'user', 'aideation-worker.service');
  assert.equal(mode(unitFile), 0o600);
  const unit = await readFile(unitFile, 'utf8');
  assert.doesNotMatch(unit, /devlog:a&|schluessel|DEV_LOG_DATABASE_URL|DEV_LOG_SECRET_KEY/);
  const escaped = root.replaceAll('%', '%%');
  assert.ok(unit.includes(`WorkingDirectory=${escaped}\n`), unit);
  const envFile = join(home, '.config', 'aideation', 'worker.env');
  assert.ok(
    unit.includes(`ExecStart=/bin/bash "${escaped}/scripts/run-with-env.sh" "${envFile}" `),
    `ExecStart mit Wrapper und Env-Datei:\n${unit}`,
  );
  assert.equal(mode(envFile), 0o600);
  assert.ok((await readFile(envFile, 'utf8')).split('\n').includes(`DEV_LOG_DATABASE_URL=${DATABASE_URL}`));
});

test('run-with-env.sh: setzt Werte unverändert, bricht ohne oder mit offener Env-Datei ab', async () => {
  const { base } = await sandbox();
  const envFile = join(base, 'worker.env');
  await writeFile(envFile, `# Kommentar\nDEV_LOG_DATABASE_URL=${DATABASE_URL}\nDEV_LOG_SECRET_KEY=${SECRET_KEY}\n`, {
    mode: 0o600,
  });
  const wrapper = join(SCRIPTS, 'run-with-env.sh');
  const print = [
    process.execPath,
    '-e',
    'console.log(JSON.stringify([process.env.DEV_LOG_DATABASE_URL, process.env.DEV_LOG_SECRET_KEY]))',
  ];

  const ok = run('bash', [wrapper, envFile, ...print], {});
  assert.equal(ok.status, 0, ok.output);
  assert.deepEqual(JSON.parse(ok.output), [DATABASE_URL, SECRET_KEY]);

  assert.equal(run('bash', [wrapper, join(base, 'fehlt.env'), ...print], {}).status, 78);
  await chmod(envFile, 0o644);
  const open = run('bash', [wrapper, envFile, ...print], {});
  assert.equal(open.status, 78);
  assert.match(open.stderr, /chmod 600/);
  assert.ok(!open.output.includes(PASSWORD));

  await writeFile(envFile, 'kein gültiger Eintrag\n', { mode: 0o600 });
  await chmod(envFile, 0o600);
  assert.equal(run('bash', [wrapper, envFile, ...print], {}).status, 78);
});

test('Env-Datei der Dienste: leere Werte werden nicht geschrieben', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aideation-svc-'));
  const target = join(dir, 'conf', 'worker.env');
  const lib = join(SCRIPTS, 'lib', 'service-env.sh');
  const result = run(
    'bash',
    ['-c', `. "${lib}" && write_env_file "${target}" DEV_LOG_SECRET_KEY= DEV_LOG_DOMAIN=x.example`],
    {},
  );
  assert.equal(result.status, 0, result.output);
  const lines = (await readFile(target, 'utf8')).split('\n');
  assert.ok(lines.includes('DEV_LOG_DOMAIN=x.example'));
  assert.ok(!lines.some((line) => line.startsWith('DEV_LOG_SECRET_KEY')));
});

test('PowerShell-Skripte: Code außerhalb von Kommentaren nur ASCII (Windows PowerShell 5.1 ohne BOM)', async () => {
  for (const name of ['install-worker.ps1', 'run-with-env.ps1']) {
    const code = (await readFile(join(SCRIPTS, name), 'utf8'))
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'));
    assert.deepEqual(
      code.filter((line) => /[^\x20-\x7e\t]/.test(line)),
      [],
      `${name}: Nicht-ASCII-Zeichen im Code`,
    );
  }
});

test(
  'Windows-Worker: Zugänge in der Env-Datei, nicht in der Befehlszeile der Aufgabe',
  { skip: !hasPwsh },
  async () => {
    const { root, home } = await sandbox();
    const result = run('pwsh', ['-NoProfile', '-File', join(root, 'scripts', 'install-worker.ps1')], {
      HOME: home,
      LOCALAPPDATA: home,
      DEV_LOG_DATABASE_URL: DATABASE_URL,
      DEV_LOG_SECRET_KEY: SECRET_KEY,
    });
    assert.equal(result.status, 0, result.output);
    const envFile = join(home, 'AIdeation', 'worker.env');
    assert.ok(existsSync(envFile));
    const lines = (await readFile(envFile, 'utf8')).split('\n');
    assert.ok(lines.includes(`DEV_LOG_DATABASE_URL=${DATABASE_URL}`));
    assert.ok(lines.includes(`DEV_LOG_SECRET_KEY=${SECRET_KEY}`));
    const task = result.output.split('\n').find((line) => line.startsWith('Aufgabe: '));
    assert.ok(task?.includes('run-with-env.ps1') && task.includes(envFile), result.output);
    // Aufgabe läuft ohne Zeitlimit (Standard: nach 72 Stunden beendet). Kein RestartCount: Neu gestartet wird nur
    // über die Schleife in run-with-env.ps1 (Exit-Code 75), ein bewusster Stopp bleibt ein Stopp.
    const settings = result.output
      .split('\n')
      .filter((line) => line.startsWith('Einstellung: '))
      .map((line) => line.slice('Einstellung: '.length).trim());
    assert.ok(settings.includes('ExecutionTimeLimit=00:00:00'), result.output);
    assert.ok(!settings.some((line) => line.startsWith('RestartCount=')), result.output);
    assert.ok(
      !result.output.includes(PASSWORD) && !result.output.includes(SECRET_KEY),
      'keine Geheimnisse in der Ausgabe',
    );

    const printer = join(home, 'print-env.mjs');
    await writeFile(
      printer,
      'console.log(JSON.stringify([process.env.DEV_LOG_DATABASE_URL, process.env.DEV_LOG_SECRET_KEY]));',
    );
    const started = run(
      'pwsh',
      ['-NoProfile', '-File', join(SCRIPTS, 'run-with-env.ps1'), envFile, process.execPath, printer],
      {},
    );
    assert.equal(started.status, 0, started.output);
    assert.deepEqual(JSON.parse(started.output), [DATABASE_URL, SECRET_KEY]);
    const missing = run(
      'pwsh',
      ['-NoProfile', '-File', join(SCRIPTS, 'run-with-env.ps1'), join(home, 'fehlt.env'), process.execPath, printer],
      {},
    );
    assert.equal(missing.status, 78);
  },
);

test('Windows-Worker: run-with-env.ps1 kennt den Exit-Code des Neustarts aus runner-cli', async () => {
  const code = (await readFile(join(SCRIPTS, 'run-with-env.ps1'), 'utf8'))
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'));
  assert.ok(code.includes(`$RestartExitCode = ${RESTART_EXIT_CODE}`), 'Exit-Code-Vertrag mit runner-cli.ts');
  assert.ok(
    code.some((line) => /^\s*while \(\$true\)/.test(line)),
    'Neustart-Schleife',
  );
  assert.ok(
    code.some((line) => /Start-Sleep -Seconds \$delay/.test(line)),
    'Wartezeit vor dem Neustart',
  );
});

test(
  'Windows-Worker: nach „AIdeation neu starten“ startet run-with-env.ps1 den Worker binnen 30 s neu, sonst nicht',
  { skip: !hasPwsh },
  async () => {
    const { base } = await sandbox();
    const envFile = join(base, 'worker.env');
    await writeFile(envFile, `DEV_LOG_DATABASE_URL=${DATABASE_URL}\n`);
    const counter = join(base, 'starts.txt');
    // Ersatz für runner-cli: Der n-te Start endet mit dem n-ten Exit-Code aus der Befehlszeile.
    const worker = join(base, 'worker.mjs');
    await writeFile(
      worker,
      [
        "import { appendFileSync, readFileSync } from 'node:fs';",
        `appendFileSync(${JSON.stringify(counter)}, 'x');`,
        `const starts = readFileSync(${JSON.stringify(counter)}, 'utf8').length;`,
        'process.exit(Number(process.argv[1 + starts] ?? 99));',
      ].join('\n'),
    );
    const wrapper = join(SCRIPTS, 'run-with-env.ps1');
    const start = async (codes: number[], env: Record<string, string> = {}) => {
      await writeFile(counter, '');
      const begin = Date.now();
      const args = ['-NoProfile', '-File', wrapper, envFile, process.execPath, worker, ...codes.map(String)];
      const result = run('pwsh', args, env);
      return { ...result, starts: (await readFile(counter, 'utf8')).length, seconds: (Date.now() - begin) / 1000 };
    };

    // Standard-Wartezeit (5 s): Nach dem Neustart-Code läuft der Worker deutlich vor 30 s wieder.
    const restarted = await start([RESTART_EXIT_CODE, 0]);
    assert.equal(restarted.status, 0, restarted.output);
    assert.equal(restarted.starts, 2, 'nach Exit-Code 75 genau ein Neustart');
    assert.ok(restarted.seconds >= 4 && restarted.seconds < 30, `Neustart nach ${restarted.seconds} s`);
    assert.match(restarted.stderr, /startet in 5 s neu/);

    // Mehrere Neustarts hintereinander funktionieren ebenso.
    const twice = await start([RESTART_EXIT_CODE, RESTART_EXIT_CODE, 0], { AIDEATION_RESTART_DELAY_SECONDS: '0' });
    assert.equal(twice.status, 0, twice.output);
    assert.equal(twice.starts, 3);

    // Bewusstes Beenden oder echter Fehler: kein Neustart, der Exit-Code geht an die Aufgabe weiter.
    for (const code of [0, 1, 3]) {
      const ended = await start([code, 0], { AIDEATION_RESTART_DELAY_SECONDS: '0' });
      assert.equal(ended.status, code, ended.output);
      assert.equal(ended.starts, 1, `Exit-Code ${code}: kein Neustart`);
    }
  },
);
