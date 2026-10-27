import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseEnv } from '../core/env-file.js';
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
  return {
    status: result.status,
    output: `${result.stdout}${result.stderr}`,
    stdout: result.stdout,
    stderr: result.stderr,
  };
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

/** Installationsskripte mit Env-Datei und Dienst-Datei (Plist/Unit); die macOS-Skripte nur auf macOS. */
const SERVICE_SCRIPTS = [
  {
    script: 'install-worker-linux.sh',
    envFile: 'worker.env',
    service: join('.config', 'systemd', 'user', 'aideation-worker.service'),
  },
  ...(isMac
    ? [
        {
          script: 'install-worker.sh',
          envFile: 'worker.env',
          service: join('Library', 'LaunchAgents', 'com.aideation.worker.plist'),
        },
        {
          script: 'install-watchdog.sh',
          envFile: 'watchdog.env',
          service: join('Library', 'LaunchAgents', 'com.aideation.watchdog.plist'),
        },
      ]
    : []),
];

test('Installationsskripte: ohne Datenbank-URL Abbruch mit klarer Meldung statt Standardpasswort', async () => {
  for (const { script, envFile, service } of SERVICE_SCRIPTS) {
    const { root, home } = await sandbox();
    const missing = run('bash', [join(root, 'scripts', script)], { HOME: home });
    assert.equal(missing.status, 1, `${script}: ${missing.output}`);
    assert.match(missing.stderr, /FEHLER: DEV_LOG_DATABASE_URL fehlt.*start\.sh --setup/, script);
    assert.ok(!existsSync(join(home, '.config', 'aideation', envFile)), `${script}: keine Env-Datei`);
    assert.ok(!existsSync(join(home, service)), `${script}: kein Dienst`);

    // Das bekannte Standardpasswort gilt ebenfalls nicht, ausser ausdrücklich erlaubt.
    const standard = 'postgresql://devlog:devlog_local_dev@localhost:5433/aideation';
    const refused = run('bash', [join(root, 'scripts', script)], { HOME: home, DEV_LOG_DATABASE_URL: standard });
    assert.equal(refused.status, 1, `${script}: ${refused.output}`);
    assert.match(refused.stderr, /FEHLER: .*Standardpasswort/, script);
    const allowed = run('bash', [join(root, 'scripts', script)], {
      HOME: home,
      DEV_LOG_DATABASE_URL: standard,
      DEV_LOG_ALLOW_DEFAULT_DB_PASSWORD: '1',
    });
    assert.equal(allowed.status, 0, `${script}: ${allowed.output}`);
    assert.match(allowed.stderr, /WARNUNG: .*Standardpasswort/, script);
  }
});

test('Installationsskripte: Zugang aus der .env der Installation, auch in einer frischen Shell', async () => {
  for (const { script, envFile } of SERVICE_SCRIPTS) {
    const { root, home } = await sandbox();
    const target = join(home, '.config', 'aideation', envFile);
    // Alte Env-Datei des Dienstes mit dem früheren Passwort: Die .env des Einrichtungs-Assistenten geht vor.
    await mkdir(join(home, '.config', 'aideation'), { recursive: true });
    await writeFile(target, 'DEV_LOG_DATABASE_URL=postgresql://devlog:veraltet@localhost:5433/aideation\n');
    const fromSetup = 'postgresql://devlog:3f9a%2Bneu@localhost:5433/aideation';
    await writeFile(
      join(root, '.env'),
      `# vom Assistenten\nDEV_LOG_DB_PASSWORD=x\nDEV_LOG_DATABASE_URL='${fromSetup}'\nexport DEV_LOG_SECRET_KEY=geheim # Kommentar\n`,
    );
    const first = run('bash', [join(root, 'scripts', script)], { HOME: home });
    assert.equal(first.status, 0, `${script}: ${first.output}`);
    assert.doesNotMatch(first.stderr, /WARNUNG|FEHLER/, script);
    const lines = (await readFile(target, 'utf8')).split('\n');
    assert.ok(lines.includes(`DEV_LOG_DATABASE_URL=${fromSetup}`), `${script}: ${lines.join('\n')}`);
    assert.ok(lines.includes('DEV_LOG_SECRET_KEY=geheim'), script);

    // Ohne .env behält ein erneuter Lauf den Zugang aus der Env-Datei des Dienstes; die Umgebung geht allem vor.
    await rm(join(root, '.env'));
    assert.equal(run('bash', [join(root, 'scripts', script)], { HOME: home }).status, 0, script);
    assert.ok((await readFile(target, 'utf8')).split('\n').includes(`DEV_LOG_DATABASE_URL=${fromSetup}`), script);
    assert.equal(
      run('bash', [join(root, 'scripts', script)], { HOME: home, DEV_LOG_DATABASE_URL: DATABASE_URL }).status,
      0,
    );
    assert.ok((await readFile(target, 'utf8')).split('\n').includes(`DEV_LOG_DATABASE_URL=${DATABASE_URL}`), script);
  }
});

test('dotenv_get liest die .env nach denselben Regeln wie parseEnv', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aideation-dotenv-'));
  const file = join(dir, 'werte.env');
  const content = [
    '# Kommentar=nein',
    'A=eins',
    "B='mit # Raute und Leerzeichen '",
    'C="doppelt"',
    'export D=wert # Kommentar',
    '  E = mit   Abstand  ',
    'F=a#b',
    "G='",
    'A=zwei',
    'H=windows\r',
    '   # I=kommentiert',
  ].join('\n');
  await writeFile(file, content);
  const lib = join(SCRIPTS, 'lib', 'service-env.sh');
  const expected = parseEnv(content);
  for (const key of ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'FEHLT']) {
    const result = run('bash', ['-c', `. "${lib}" && dotenv_get "${file}" ${key}`], {});
    assert.equal(result.status, 0, result.output);
    assert.equal(result.stdout, expected.get(key) ?? '', `Schlüssel ${key}`);
  }
});

test('Log-Rotation: newsyslog-Regel ohne Signal, Rechte 600 für das neue Log, mehrfach ausführbar', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aideation-newsyslog-'));
  const rules = join(dir, 'newsyslog.d');
  const lib = join(SCRIPTS, 'lib', 'service-env.sh');
  const install = (log: string) =>
    run('bash', ['-c', `. "${lib}" && install_log_rotation aideation-worker "${log}" 5 10240`], {
      AIDEATION_NEWSYSLOG_DIR: rules,
    });
  const log = join(dir, 'Logs', 'aideation-worker.log');
  const first = install(log);
  assert.equal(first.status, 0, first.output);
  const file = join(rules, 'aideation-worker.conf');
  assert.equal(mode(file), 0o644);
  const user = spawnSync('id', ['-un'], { encoding: 'utf8' }).stdout.trim();
  const group = spawnSync('id', ['-gn'], { encoding: 'utf8' }).stdout.trim();
  const rule = (await readFile(file, 'utf8')).split('\n').filter((line) => line && !line.startsWith('#'));
  assert.deepEqual(rule, [[log, `${user}:${group}`, '600', '5', '10240', '*', 'NJ'].join('\t')]);
  const again = install(log);
  assert.equal(again.status, 0, again.output);
  assert.match(again.stdout, /unverändert/);
  // newsyslog trennt Felder an Leerzeichen: solchen Pfad nicht halb eintragen.
  const spaced = run(
    'bash',
    ['-c', `. "${lib}" && install_log_rotation mit-leerzeichen "${join(dir, 'mit leer', 'x.log')}" 3 1024`],
    { AIDEATION_NEWSYSLOG_DIR: rules },
  );
  assert.equal(spaced.status, 0, spaced.output);
  assert.match(spaced.stderr, /WARNUNG: Log-Pfad mit Leerzeichen/);
  assert.ok(!existsSync(join(rules, 'mit-leerzeichen.conf')));
  // Probelauf ohne Testordner: /etc/newsyslog.d bleibt unberührt, kein sudo.
  const dry = run('bash', ['-c', `. "${lib}" && install_log_rotation aideation-worker "${log}" 5 10240`], {});
  assert.equal(dry.status, 0, dry.output);
  assert.match(dry.stdout, /Probelauf: Log-Rotation \/etc\/newsyslog\.d\/aideation-worker\.conf nicht angelegt/);
});

test(
  'macOS-Dienste: Worker und Wächter legen ihre Log-Rotation an, der Worker schreibt sein Log selbst',
  { skip: !isMac },
  async () => {
    for (const [script, name, plistName] of [
      ['install-worker.sh', 'aideation-worker', 'com.aideation.worker.plist'],
      ['install-watchdog.sh', 'aideation-watchdog', 'com.aideation.watchdog.plist'],
    ]) {
      const { base, root, home } = await sandbox();
      const rules = join(base, 'newsyslog.d');
      const result = run('bash', [join(root, 'scripts', script)], {
        HOME: home,
        DEV_LOG_DATABASE_URL: DATABASE_URL,
        AIDEATION_NEWSYSLOG_DIR: rules,
      });
      assert.equal(result.status, 0, result.output);
      const log = join(home, 'Library', 'Logs', `${name}.log`);
      const rule = await readFile(join(rules, `${name}.conf`), 'utf8');
      assert.ok(rule.split('\n').some((line) => line.startsWith(`${log}\t`)), rule);
      const plist = join(home, 'Library', 'LaunchAgents', plistName);
      const parsed = JSON.parse(
        spawnSync('plutil', ['-convert', 'json', '-o', '-', plist], { encoding: 'utf8' }).stdout,
      );
      assert.equal(parsed.StandardOutPath, log);
      if (name === 'aideation-worker') assert.equal(parsed.EnvironmentVariables.DEV_LOG_LOG_FILE, log);
    }
  },
);

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

test('Worker-Dienst übernimmt einen eigenen Ablageort der Playwright-Browser (Smoke-Tests der Spiele)', async () => {
  const browsers = '/opt/browser cache/ms-playwright';
  const scripts = ['install-worker-linux.sh', ...(isMac ? ['install-worker.sh'] : [])];
  for (const script of scripts) {
    const { root, home } = await sandbox();
    const envFile = join(home, '.config', 'aideation', 'worker.env');
    const env = { HOME: home, DEV_LOG_DATABASE_URL: DATABASE_URL, DEV_LOG_SECRET_KEY: SECRET_KEY };
    const first = run('bash', [join(root, 'scripts', script)], { ...env, PLAYWRIGHT_BROWSERS_PATH: browsers });
    assert.equal(first.status, 0, first.output);
    assert.ok((await readFile(envFile, 'utf8')).split('\n').includes(`PLAYWRIGHT_BROWSERS_PATH=${browsers}`), script);
    // Erneuter Lauf ohne die Variable behält den Wert; ohne Angabe steht er gar nicht in der Datei.
    assert.equal(run('bash', [join(root, 'scripts', script)], env).status, 0);
    assert.match(await readFile(envFile, 'utf8'), /PLAYWRIGHT_BROWSERS_PATH=\/opt\/browser cache/);
    const fresh = await sandbox();
    run('bash', [join(fresh.root, 'scripts', script)], { ...env, HOME: fresh.home });
    assert.doesNotMatch(
      await readFile(join(fresh.home, '.config', 'aideation', 'worker.env'), 'utf8'),
      /PLAYWRIGHT_BROWSERS_PATH/,
    );
  }
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
