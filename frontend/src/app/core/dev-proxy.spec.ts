import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

const root = new URL('../../../../', import.meta.url);
const proxy = JSON.parse(readFileSync(new URL('frontend/proxy.conf.json', root), 'utf8')) as Record<
  string,
  { target: string }
>;

/** Host-Ports, die docker-compose.yml samt deploy/compose/ports.*.yml veröffentlicht (Kurz- und Langform). */
function publishedPorts(): Set<number> {
  const files = [
    new URL('docker-compose.yml', root),
    ...readdirSync(new URL('deploy/compose/', root))
      .filter((name) => /^ports\..+\.ya?ml$/.test(name))
      .map((name) => new URL(`deploy/compose/${name}`, root)),
  ];
  const ports = new Set<number>();
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    // Kurzform: "3100:8080", "127.0.0.1:3100:8080", "[::1]:3100:8080"
    for (const match of text.matchAll(/^\s*-\s*["']?(?:[\d.]+:|\[[^\]]*\]:)?(\d+):\d+(?:\/\w+)?["']?\s*$/gm)) {
      ports.add(Number(match[1]));
    }
    // Langform: published: 3100
    for (const match of text.matchAll(/^\s*published:\s*["']?(\d+)/gm)) ports.add(Number(match[1]));
  }
  return ports;
}

test('Erkennung der Compose-Ports findet den Live-Port der Oberfläche', () => {
  assert.ok(publishedPorts().has(3100));
});

test('Dev-Proxy zielt auf localhost und nutzt keinen von Compose veröffentlichten Port', () => {
  const published = publishedPorts();
  const entries = Object.entries(proxy);
  assert.ok(entries.length > 0);
  for (const [path, { target }] of entries) {
    const url = new URL(target);
    assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), `${path}: ${target} ist nicht lokal`);
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    assert.ok(!published.has(port), `${path}: Port ${port} gehört dem Compose-Stack`);
  }
});
