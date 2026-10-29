import assert from 'node:assert/strict';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseNodeCoverage } from '../runner/measured-coverage.js';
import { MAX_CAPTURED_OUTPUT, OUTPUT_GRACE_MS, redactOutput, runCommand } from './command.js';
import { setProcessStore, type TrackedProcess } from './shutdown.js';

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Ein per SIGKILL beendeter, verwaister Prozess verschwindet erst, wenn das System ihn abräumt: kurz warten. */
async function gone(pid: number, waitMs = 2_000): Promise<boolean> {
  const until = Date.now() + waitMs;
  while (alive(pid)) {
    if (Date.now() > until) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return true;
}

test('Zeitlimit beendet die ganze Prozessgruppe, auch Kindprozesse, die stdout offen halten', async () => {
  const startedAt = Date.now();
  // Ohne Gruppen-Kill lebten die beiden sleep weiter, hielten die Pipe offen, und runCommand käme erst nach 30 s zurück.
  // Grenze 15 s: weit darunter, aber mit Luft, wenn die ganze Suite parallel läuft.
  const result = await runCommand(['sh', '-c', 'sleep 30 & echo "child $!"; sleep 30'], process.cwd(), {
    timeoutMs: 300,
  });
  assert.ok(Date.now() - startedAt < 15_000, `dauerte ${Date.now() - startedAt} ms`);
  assert.notEqual(result.exitCode, 0);
  assert.match(result.output, /Process ended by SIGKILL \(timeout or kill\)/);
  const child = Number(/child (\d+)/.exec(result.output)?.[1]);
  assert.ok(child > 0);
  assert.equal(await gone(child), true, 'Hintergrundprozess wurde mit beendet');
});

test('ein Enkelprozess ausserhalb der Gruppe hält das Ergebnis nicht auf', async () => {
  // Der Enkel startet in eigener Gruppe (detached), erbt aber stdout und hält die Pipe offen.
  const script =
    "const c = require('node:child_process').spawn('sleep', ['30'], { detached: true, stdio: 'inherit' });" +
    "console.log('grandchild ' + c.pid); c.unref();";
  const startedAt = Date.now();
  const result = await runCommand([process.execPath, '-e', script], process.cwd());
  const grandchild = Number(/grandchild (\d+)/.exec(result.output)?.[1]);
  try {
    assert.equal(result.exitCode, 0);
    assert.ok(grandchild > 0);
    assert.ok(Date.now() - startedAt < OUTPUT_GRACE_MS + 3_000, `dauerte ${Date.now() - startedAt} ms`);
  } finally {
    if (grandchild > 0 && alive(grandchild)) process.kill(grandchild, 'SIGKILL');
  }
});

test('auch nach einem erfolgreichen Befehl endet, was er im Hintergrund gestartet hat (z. B. Dev-Server)', async () => {
  // Der Hintergrundprozess schliesst stdout, damit runCommand nicht erst über das Zeitlimit zurückkommt.
  const result = await runCommand(['sh', '-c', 'sleep 30 >/dev/null 2>&1 & echo "child $!"'], process.cwd(), {
    timeoutMs: 10_000,
  });
  const child = Number(/child (\d+)/.exec(result.output)?.[1]);
  try {
    assert.equal(result.exitCode, 0);
    assert.ok(child > 0);
    // SIGKILL ist asynchron zugestellt; kurz warten, bis der Prozess weg ist.
    for (let attempt = 0; attempt < 20 && alive(child); attempt += 1) await new Promise((r) => setTimeout(r, 50));
    assert.equal(alive(child), false, 'Hintergrundprozess läuft nach dem Befehl weiter');
  } finally {
    if (child > 0 && alive(child)) process.kill(child, 'SIGKILL');
  }
});

test('der Prozess steht während des Laufs im Prozessregister und wird danach entfernt', async () => {
  const added: TrackedProcess[] = [];
  const removed: TrackedProcess[] = [];
  setProcessStore({ add: (entry) => added.push(entry), remove: (entry) => removed.push(entry) });
  try {
    let spawned = 0;
    await runCommand(['sh', '-c', 'exit 0'], process.cwd(), {
      onSpawn: (pid) => {
        spawned = pid;
        assert.equal(added.length, 1, 'Eintrag besteht vor dem Start der Arbeit');
      },
    });
    assert.equal(added[0]?.pid, spawned);
    assert.equal(added[0]?.command, 'sh');
    assert.ok(added[0]?.startedAt instanceof Date);
    assert.deepEqual(removed, added);
  } finally {
    setProcessStore(null);
  }
});

test('ein normaler Befehl liefert Ausgabe und Exit-Code wie bisher', async () => {
  const result = await runCommand(['sh', '-c', 'echo hallo; exit 3'], process.cwd(), { timeoutMs: 5_000 });
  assert.equal(result.exitCode, 3);
  assert.equal(result.output, 'hallo\n');
});

test('runCommand names a missing working directory instead of blaming the PATH', async () => {
  const missing = join(tmpdir(), `dev-log-missing-${process.pid}-${Date.now()}`);
  const result = await runCommand(['git', 'status'], missing);
  assert.notEqual(result.exitCode, 0);
  assert.match(result.output, /Arbeitsordner nicht erreichbar/);
  assert.doesNotMatch(result.output, /im PATH des Workers nicht gefunden/);
});

test('runCommand still points to the PATH when the command itself is missing', async () => {
  const result = await runCommand(['dev-log-gibt-es-nicht'], tmpdir());
  assert.notEqual(result.exitCode, 0);
  assert.match(result.output, /im PATH des Workers nicht gefunden/);
});

test('ein Umlaut, der über eine Chunk-Grenze fällt, bleibt erhalten', async () => {
  // „ä“ = 0xC3 0xA4: erstes Byte, Pause, zweites Byte – landet in zwei getrennten Chunks.
  const script =
    'process.stdout.write(Buffer.from([0x47, 0xc3]));' +
    'setTimeout(() => process.stdout.write(Buffer.from([0xa4, 0x72, 0x74, 0x0a])), 150);';
  const chunks: string[] = [];
  const result = await runCommand([process.execPath, '-e', script], process.cwd(), {
    onChunk: (chunk) => chunks.push(chunk),
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.output, 'Gärt\n');
  assert.equal(chunks.join(''), 'Gärt\n');
  assert.ok(!chunks.join('').includes('�'));
});

test('lange Ausgabe: Kopf und Ende bleiben, das Ende enthält Fehlerzusammenfassung und Coverage', async () => {
  // 300 kB Testlauf auf stdout, dazwischen stderr; die Zusammenfassung steht wie beim Node-Test-Runner ganz am Schluss.
  const script =
    "process.stdout.write('ANFANG\\n');" +
    "for (let i = 0; i < 3000; i += 1) { process.stdout.write('ok ' + i + ' ' + 'x'.repeat(90) + '\\n'); if (i % 500 === 0) process.stderr.write('warnung ' + i + '\\n'); }" +
    "process.stdout.write('# pass 63\\n# fail 1\\n# all files | 84.02 | 82.64 | 91.78 |\\n');";
  const result = await runCommand([process.execPath, '-e', script], process.cwd());
  assert.equal(result.exitCode, 0);
  assert.ok(result.output.length <= MAX_CAPTURED_OUTPUT + 200, `zu lang: ${result.output.length}`);
  assert.ok(result.output.startsWith('ANFANG\n'));
  assert.match(result.output, /Zeichen der Ausgabe ausgelassen/);
  assert.match(result.output, /ok 2999 x+\n# pass 63\n# fail 1\n# all files/);
  assert.deepEqual(parseNodeCoverage(result.output), {
    lines: 84.02,
    branches: 82.64,
    functions: 91.78,
    passed: 63,
    failed: 1,
  });
});

test('Emoji und Umlaut auf der Chunk- und Kürzungsgrenze bleiben ganz', async () => {
  // „😀“ = F0 9F 98 80: Bytes über zwei Chunks verteilt. Die Längen sind so gewählt, dass Kopf- und Endgrenze
  // (20 000 bzw. 100 000 Zeichen vor Schluss) genau zwischen die Hälften eines Emojis fallen.
  const script =
    'process.stdout.write(Buffer.from([0xf0, 0x9f]));' +
    "setTimeout(() => { process.stdout.write(Buffer.from([0x98, 0x80])); process.stdout.write('x' + 'ä😀'.repeat(70000) + 'ENDE!!'); }, 100);";
  const result = await runCommand([process.execPath, '-e', script], process.cwd());
  assert.equal(result.exitCode, 0);
  assert.ok(result.output.startsWith('😀xä😀'));
  assert.ok(result.output.endsWith('😀ENDE!!'));
  assert.ok(!result.output.includes('�'));
  // Kein einzelnes Surrogat: jedes Zeichen ist gültiges UTF-16.
  assert.doesNotMatch(result.output, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
});

test('ein Secret auf der Schnittkante wird geschwärzt, keine Hälfte bleibt sichtbar', () => {
  const secret = 'geheim-0123456789';
  const env = { GITHUB_TOKEN: secret };
  // Kopf endet nach 20 000 Zeichen, Ende beginnt 100 000 Zeichen vor Schluss: Secret jeweils genau auf der Kante.
  const output = `${'a'.repeat(19_995)}${secret}${'b'.repeat(200_000)}${secret}${'c'.repeat(99_990)}`;
  const safe = redactOutput(output, env);
  assert.ok(safe.length <= MAX_CAPTURED_OUTPUT + 200);
  assert.ok(safe.endsWith('c'.repeat(1000)));
  for (let length = 4; length < secret.length; length += 1) {
    assert.ok(!safe.includes(secret.slice(0, length)), `Anfang des Secrets sichtbar: ${secret.slice(0, length)}`);
    assert.ok(!safe.includes(secret.slice(-length)), `Ende des Secrets sichtbar: ${secret.slice(-length)}`);
  }
});

test('runCommand schwärzt Secrets der Umgebung, bevor gekürzt wird', async () => {
  const secret = 'pw-1234567890-geheim';
  const script =
    "const s = process.env.DB_PASSWORD; process.stdout.write('x'.repeat(19990) + s + 'y'.repeat(200000) + s);";
  const result = await runCommand([process.execPath, '-e', script], process.cwd(), {
    env: { ...process.env, DB_PASSWORD: secret },
  });
  assert.ok(!result.output.includes(secret.slice(0, 6)));
  assert.ok(!result.output.includes(secret.slice(-6)));
  assert.ok(result.output.endsWith('[REDACTED]'));
});

test('stdout und stderr kommen getrennt bei onChunk an', async () => {
  const script = "process.stdout.write('{\"a\":'); process.stderr.write('warnung\\n'); process.stdout.write('1}\\n');";
  const streams: Record<string, string> = { stdout: '', stderr: '' };
  await runCommand([process.execPath, '-e', script], process.cwd(), {
    onChunk: (chunk, stream) => {
      streams[stream ?? 'stdout'] += chunk;
    },
  });
  assert.equal(streams.stdout, '{"a":1}\n');
  assert.equal(streams.stderr, 'warnung\n');
});

test('redactOutput maskiert API-Schlüssel, Tokens und Secrets aus der Umgebung', () => {
  const env = {
    ANTHROPIC_API_KEY: 'sk-ant-geheim-1234',
    OPENAI_APIKEY: 'openai-geheim',
    GITHUB_TOKEN: 'ghtoken-geheim',
    STRIPE_SECRET: 'stripe-geheim',
    AWS_ACCESS_KEY: 'aws-geheim',
    HOME: '/Users/test',
  };
  const output = redactOutput(
    'key=sk-ant-geheim-1234 openai-geheim ghtoken-geheim stripe-geheim aws-geheim /Users/test',
    env,
  );
  assert.equal(output, 'key=[REDACTED] [REDACTED] [REDACTED] [REDACTED] [REDACTED] /Users/test');
});

test('redactOutput maskiert Token-Formate, die nicht im Environment stehen (aus Projekt-DB, Dateien, Ausgaben)', () => {
  const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA1234\nabcd\n-----END RSA PRIVATE KEY-----';
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
  const secrets = [
    'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz012345',
    `ghp_${'A1b2C3d4E5'.repeat(3)}abcdef`,
    pem,
    jwt,
    'Authorization: Bearer 9f8e7d6c5b4a39281706abcdef',
    'postgres://shop:Sup3rGeheim@db.example.ch:5432/shop',
  ];
  const output = redactOutput(`| token |\n${secrets.join('\n')}\nfertig`, {});
  const parts = ['AbCdEfGhIjKlMnOp', 'A1b2C3d4E5', 'MIIEowIBAAKCAQEA', 'dozjgNryP4J3', '9f8e7d6c5b4a', 'Sup3rGeheim'];
  for (const secret of parts) {
    assert.ok(!output.includes(secret), `sichtbar: ${secret}\n${output}`);
  }
  assert.match(output, /Authorization: Bearer \[REDACTED\]/);
  assert.match(output, /postgres:\/\/\[REDACTED\]@db\.example\.ch:5432\/shop/);
  assert.ok(output.endsWith('\nfertig'));
});

test('redactOutput: Gegenproben ohne echten Token, Token- und Kostenzahlen bleiben unverändert', () => {
  const text = [
    'Präfixe wie sk-, sk-ant-, ghp_ und github_pat_ erkennt der Wächter.',
    'Bearer authentication und Basic configuration sind Begriffe, Token counting auch.',
    '{"type":"result","total_cost_usd":0.4213,"usage":{"input_tokens":1234,"output_tokens":567},"session_id":"3f2a"}',
    'at src/api/session.ts:12:5 · auth.test.ts:40 · password=*** · user@example.ch · 10.0.0.1',
    'https://example.ch/pfad?x=1 und eyJ allein',
  ].join('\n');
  assert.equal(redactOutput(text, {}), text);
});
