import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { formatEnvValue, mergeEnv, parseEnv, planEnv, validateInstall, writeEnvFile } from './env-file.js';

const input = {
  username: 'admin',
  password: 'ein-sehr-langes-passwort',
  domain: '',
  projectRoots: '/Users/du/Projekte',
};
const valid = { ...input, installWorker: true };

/** Jeder Test bekommt ein eigenes temporäres Verzeichnis; die echte .env bleibt unberührt. */
async function inTemp(run: (file: string, dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'aideation-env-'));
  try {
    await run(join(dir, '.env'), dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('without an existing .env, secret key and DB password are generated', () => {
  const plan = planEnv('', input);
  const key = plan.values.get('DEV_LOG_SECRET_KEY')!;
  const dbPassword = plan.values.get('DEV_LOG_DB_PASSWORD')!;
  assert.ok(plan.secretKeyCreated && plan.dbPasswordCreated);
  assert.ok(key.length >= 16, 'meets the minimum length from secrets.ts');
  assert.notEqual(dbPassword, 'devlog_local_dev');
  assert.ok(dbPassword.length >= 32);
  assert.equal(plan.values.get('DEV_LOG_DATABASE_URL'), `postgresql://devlog:${dbPassword}@localhost:5433/aideation`);
  assert.equal(plan.values.get('DEV_LOG_USERNAME'), 'admin');
  assert.equal(plan.values.get('DEV_LOG_PROJECT_ROOTS'), '/Users/du/Projekte');
  assert.match(plan.content, /^# AIdeation/);
  assert.notEqual(planEnv('', input).values.get('DEV_LOG_SECRET_KEY'), key, 'random on every new install');
});

test('foreign keys, comments and order stay, only form values change', () => {
  const existing = [
    '# eigene Notiz',
    'DEV_LOG_OWN_DOMAINS=example.com,example.org',
    'DEV_LOG_DB_USER=app',
    'DEV_LOG_DB_PASSWORD=altes-db-passwort',
    'DEV_LOG_DATABASE_URL=postgresql://app:altes-db-passwort@localhost:5433/aideation',
    'DEV_LOG_USERNAME=alt',
    '',
    'DEV_LOG_SECRET_KEY=vorhandener-schluessel-123',
    'DEV_LOG_OLLAMA_MODEL=qwen3.5:9b',
  ].join('\n');
  const plan = planEnv(existing, { ...input, projectRoots: '' });
  const lines = plan.content.trimEnd().split('\n');
  assert.deepEqual(lines.slice(0, 5), existing.split('\n').slice(0, 5));
  assert.equal(lines[5], 'DEV_LOG_USERNAME=admin', 'replaced in place');
  assert.equal(lines[7], 'DEV_LOG_SECRET_KEY=vorhandener-schluessel-123');
  assert.equal(lines[8], 'DEV_LOG_OLLAMA_MODEL=qwen3.5:9b');
  assert.ok(!plan.secretKeyCreated && !plan.dbPasswordCreated);
  assert.equal(plan.values.get('DEV_LOG_OWN_DOMAINS'), 'example.com,example.org');
  assert.equal(plan.values.has('DEV_LOG_PROJECT_ROOTS'), false, 'empty field adds nothing');
});

test('an empty secret key is replaced, a missing DB password gets the configured DB user', () => {
  const plan = planEnv('DEV_LOG_SECRET_KEY=\nDEV_LOG_DB_USER=app\nDEV_LOG_DOMAIN=alt.example.com\n', input);
  assert.ok(plan.secretKeyCreated && plan.dbPasswordCreated);
  assert.ok(plan.values.get('DEV_LOG_SECRET_KEY')!.length >= 16);
  assert.match(plan.values.get('DEV_LOG_DATABASE_URL')!, /^postgresql:\/\/app:[0-9a-f]{48}@localhost:5433\/aideation$/);
  assert.equal(plan.values.get('DEV_LOG_DOMAIN'), 'alt.example.com', 'empty domain keeps the existing one');
  assert.equal(plan.content.match(/DEV_LOG_SECRET_KEY=/g)!.length, 1);
});

test('values with spaces are quoted, line breaks are rejected', () => {
  assert.equal(formatEnvValue('/Users/du/Meine Projekte'), "'/Users/du/Meine Projekte'");
  assert.equal(formatEnvValue('/srv/a,/srv/b'), '/srv/a,/srv/b');
  assert.throws(() => formatEnvValue('/a\nDEV_LOG_AUTH=off'), /Zeilenumbrüche/);
  const merged = mergeEnv('A=1\nA=2\n', new Map([['A', '$x y']]));
  assert.equal(merged, "A='$x y'\n", 'duplicates collapse, $ stays literal');
  assert.equal(parseEnv(merged).get('A'), '$x y');
  assert.equal(parseEnv("export B='mit # Raute'\nC=wert # Kommentar").get('B'), 'mit # Raute');
  assert.equal(parseEnv('C=wert # Kommentar').get('C'), 'wert');
});

test('install input is checked for type and line breaks', () => {
  assert.equal(validateInstall(valid), null);
  assert.equal(
    validateInstall({ ...valid, domain: undefined, projectRoots: undefined, installWorker: undefined }),
    null,
  );
  assert.match(validateInstall({ ...valid, projectRoots: '/a\nDEV_LOG_AUTH=off' })!, /Zeilenumbrüche/);
  assert.match(validateInstall({ ...valid, projectRoots: ['/a'] })!, /Text/);
  assert.match(validateInstall({ ...valid, projectRoots: "/a'b" })!, /'/);
  assert.match(validateInstall({ ...valid, username: 12345 })!, /Benutzername/);
  assert.match(validateInstall({ ...valid, password: 'x'.repeat(15) })!, /16 Zeichen/);
  assert.match(validateInstall({ ...valid, domain: 'kein domain' })!, /Domain/);
  assert.match(validateInstall({ ...valid, installWorker: 'ja' })!, /Worker/);
  assert.match(validateInstall(null)!, /Ungültig/);
});

test('running the wizard twice keeps the secret key and DB password, backups are private', async () => {
  await inTemp(async (file, dir) => {
    await writeFile(file, '# Notiz\nDEV_LOG_OWN_DOMAINS=example.com\n');
    const first = await writeEnvFile(file, input);
    assert.ok(first.backup && first.secretKeyCreated);
    assert.equal(await readFile(first.backup, 'utf8'), '# Notiz\nDEV_LOG_OWN_DOMAINS=example.com\n');

    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await writeEnvFile(file, { ...input, username: 'zweiter' });
    assert.ok(!second.secretKeyCreated && !second.dbPasswordCreated);
    const values = parseEnv(await readFile(file, 'utf8'));
    assert.equal(values.get('DEV_LOG_SECRET_KEY'), first.values.get('DEV_LOG_SECRET_KEY'));
    assert.equal(values.get('DEV_LOG_DB_PASSWORD'), first.values.get('DEV_LOG_DB_PASSWORD'));
    assert.equal(values.get('DEV_LOG_OWN_DOMAINS'), 'example.com');
    assert.equal(values.get('DEV_LOG_USERNAME'), 'zweiter');

    const files = (await readdir(dir)).sort();
    assert.equal(files.filter((name) => name.startsWith('.env.bak-')).length, 2);
    assert.equal(
      files.some((name) => name.includes('.tmp-')),
      false,
      'no temporary file left behind',
    );
    if (process.platform !== 'win32') {
      assert.equal((await stat(file)).mode & 0o777, 0o600);
      assert.equal((await stat(second.backup!)).mode & 0o777, 0o600);
    }
  });
});

test('first write without .env creates no backup', async () => {
  await inTemp(async (file) => {
    const result = await writeEnvFile(file, input);
    assert.equal(result.backup, null);
    assert.ok(result.secretKeyCreated);
  });
});
