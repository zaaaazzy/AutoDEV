import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

// Härtung der Container (Review 21.10.2026): ohne Docker geprüft, nur aus den Dateien.
const ROOT = join(import.meta.dirname, '..', '..');
const read = (file: string): string => readFileSync(join(ROOT, file), 'utf8');

/** Dienste aus docker-compose.yml: Name → eingerückter Block (ohne YAML-Bibliothek). */
function services(): Map<string, string> {
  const section = read('docker-compose.yml').split(/^services:\n/m)[1].split(/^\S/m)[0];
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
};
const READ_ONLY = ['frontend', 'backup', 'https', 'https-volumes'];

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

test('Compose: Healthcheck für lang laufende Dienste, read_only für frontend, backup und https', () => {
  for (const [name, block] of services()) {
    if (name !== 'https-volumes') assert.match(block, /^ {4}healthcheck:$/m, `${name}: healthcheck`);
    if (!READ_ONLY.includes(name)) continue;
    assert.match(block, /^ {4}read_only: true$/m, `${name}: read_only`);
    if (name !== 'https-volumes') assert.match(block, /^ {4}tmpfs: \[\/tmp\]$/m, `${name}: /tmp als tmpfs`);
  }
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
