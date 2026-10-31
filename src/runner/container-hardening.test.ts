import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

// Härtung der Container (Review 21.10.2026): ohne Docker geprüft, nur aus den Dateien.
const ROOT = join(import.meta.dirname, '..', '..');
const read = (file: string): string => readFileSync(join(ROOT, file), 'utf8');

/** Dienste aus docker-compose.yml: Name → eingerückter Block (ohne YAML-Bibliothek). */
function services(): Map<string, string> {
  const section = read('docker-compose.yml')
    .split(/^services:\n/m)[1]
    .split(/^\S/m)[0];
  const blocks = new Map<string, string>();
  for (const [, name, block] of section.matchAll(/^ {2}([\w-]+):\n((?:(?: {4}.*)?\n)*)/gm)) {
    blocks.set(name, block);
  }
  return blocks;
}

/** Erlaubte Capabilities je Dienst nach cap_drop: [ALL] – Begründung steht in docker-compose.yml. */
const CAP_ADD: Record<string, string[]> = {
  db: ['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'SETGID', 'SETUID'],
  'dev-log': [],
  frontend: [],
  backup: [],
  https: ['NET_BIND_SERVICE'],
  'https-volumes': ['CHOWN', 'DAC_OVERRIDE'],
  worker: [],
  'worker-volumes': ['CHOWN', 'DAC_OVERRIDE'],
  watchdog: [],
};
const READ_ONLY = ['frontend', 'backup', 'https', 'https-volumes', 'worker-volumes', 'watchdog'];
/** Einmalige Schritte (chown eines Volumes, dann Ende): kein Healthcheck, kein /tmp. */
const ONE_SHOT = ['https-volumes', 'worker-volumes'];

test('Compose: jeder Dienst ohne Capabilities, mit no-new-privileges und nur begründeten cap_add', () => {
  const all = services();
  assert.deepEqual([...all.keys()].sort(), Object.keys(CAP_ADD).sort());
  for (const [name, block] of all) {
    assert.match(block, /^ {4}cap_drop: \[ALL\]$/m, `${name}: cap_drop`);
    assert.match(block, /^ {4}security_opt: \["no-new-privileges:true"\]$/m, `${name}: no-new-privileges`);
    const added = block.match(/^ {4}cap_add: \[(.*)\]$/m)?.[1] ?? '';
    assert.deepEqual(added ? added.split(', ') : [], CAP_ADD[name], `${name}: cap_add`);
  }
});

test('Compose: Healthcheck für lang laufende Dienste, read_only für frontend, backup, https und watchdog', () => {
  for (const [name, block] of services()) {
    if (!ONE_SHOT.includes(name)) assert.match(block, /^ {4}healthcheck:$/m, `${name}: healthcheck`);
    if (!READ_ONLY.includes(name)) continue;
    assert.match(block, /^ {4}read_only: true$/m, `${name}: read_only`);
    if (!ONE_SHOT.includes(name)) assert.match(block, /^ {4}tmpfs: \[\/tmp\]$/m, `${name}: /tmp als tmpfs`);
  }
});

/** Zeilen ohne Kommentar, die den Docker-Socket nennen. */
const socketLines = (text: string): string[] =>
  text.split('\n').filter((line) => !line.trim().startsWith('#') && /docker\.sock/.test(line));

test('Compose: nur der Dienst worker hat den Docker-Socket gemountet', () => {
  const withSocket = [...services()].filter(([, block]) => socketLines(block).length).map(([name]) => name);
  assert.deepEqual(withSocket, ['worker']);
  // Auch ausserhalb der Dienstblöcke (z. B. über Anker) steht der Socket nirgends sonst.
  assert.deepEqual(socketLines(read('docker-compose.yml')), ['      - /var/run/docker.sock:/var/run/docker.sock']);
});

test('Compose: Worker als Dienst im Profil worker, Neustart über die Restart-Richtlinie (Exit-Code 75)', () => {
  const all = services();
  for (const name of ['worker', 'worker-volumes', 'watchdog'])
    assert.match(all.get(name) ?? '', /^ {4}profiles: \["worker"\]$/m, `${name}: Profil worker`);
  const worker = all.get('worker') ?? '';
  assert.match(worker, /^ {4}restart: unless-stopped$/m);
  assert.match(worker, /^ {4}build: deploy\/worker$/m);
  assert.match(worker, /DEV_LOG_WORKER_CONTAINER: "1"/);
  // Keine Git-Zugänge in docker-compose.yml: die bindet nur docker-compose.override.yml ein (nur worker, :ro).
  for (const [name, block] of all) assert.doesNotMatch(block, /\.ssh|\.gitconfig|config\/gh|github_token/, name);
  // Der Wächter braucht weder Docker noch Git-Zugang.
  assert.doesNotMatch(all.get('watchdog') ?? '', /docker\.sock|GH_TOKEN|CLAUDE_CODE_OAUTH_TOKEN/);
  const entrypoint = read('deploy/worker/entrypoint.sh');
  assert.match(entrypoint, /exec node "\$tsx" src\/runner\/runner-cli\.ts --all --watch --limit 3/);
  assert.match(read('deploy/worker/Dockerfile'), /docker-ce-cli docker-compose-plugin docker-buildx-plugin gh/);
});

test('Frontend: nginx-unprivileged (Master ohne root) auf 8080, Healthcheck und Port-Mapping passen', () => {
  const dockerfile = read('deploy/frontend/Dockerfile');
  const runtime = dockerfile.split(/^FROM /m).at(-1) ?? '';
  assert.match(runtime, /^nginxinc\/nginx-unprivileged:\d+\.\d+\.\d+-alpine$/m);
  assert.match(runtime, /^USER nginx$/m);
  assert.doesNotMatch(runtime, /^USER root/m);
  assert.match(read('deploy/frontend/nginx.conf'), /^\s+listen 8080;$/m);
  assert.match(services().get('frontend') ?? '', /http:\/\/127\.0\.0\.1:8080\/health/);
  assert.match(read('deploy/compose/ports.aideation.yml'), /"127\.0\.0\.1:3100:8080"/);
});

test('Review-Image: läuft als node, npm-Cache im Home von node statt /root', () => {
  const dockerfile = read('deploy/review/Dockerfile');
  assert.match(dockerfile, /^USER node$/m);
  assert.match(dockerfile, /chown node:node \/work \/home\/node\/\.npm/);
  assert.doesNotMatch(read('src/runner/review-slots.ts'), /\/root\/\.npm/);
});

test('Compose: jedes eigene Image baut genau ein Dienst, die übrigen nutzen es nur (pull_policy: never)', () => {
  // Gleichzeitige Builds desselben Images scheitern mit dem containerd-Image-Store an „image … already exists“.
  const builders = new Map<string, string[]>();
  for (const [name, block] of services()) {
    const image = /^ {4}image: (\S+)$/m.exec(block)?.[1];
    if (!image || !/^ {4}build:/m.test(block)) continue;
    builders.set(image, [...(builders.get(image) ?? []), name]);
  }
  for (const [image, names] of builders) assert.equal(names.length, 1, `${image}: ${names.join(', ')}`);
  for (const name of ['worker-volumes', 'watchdog', 'https-volumes']) {
    const block = services().get(name) ?? '';
    assert.doesNotMatch(block, /^ {4}build:/m, name);
    assert.match(block, /^ {4}pull_policy: never$/m, name);
  }
});
