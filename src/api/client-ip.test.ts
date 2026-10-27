import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import express, { type Request } from 'express';
import { clientSource, trustProxySetting } from './security.js';

// Kette im Live-Stack: Client → (direkt 127.0.0.1:3100 | Caddy) → nginx (deploy/frontend) → Backend.
// Der Test liest die echten Konfigurationsdateien und spielt nach, was nginx und Express daraus machen.
const ROOT = join(import.meta.dirname, '..', '..');
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

const GATEWAY = '172.18.0.1'; // Absender bei Direktzugriff über den Host-Port (Gateway des Compose-Netzes)
const CADDY = '172.18.0.4';
const NGINX = '172.18.0.3';

interface Server {
  port: number;
  directives: string[];
}

/** server-Blöcke von nginx.conf mit ihren Anweisungen, includes von app-locations.conf aufgelöst. */
function nginxServers(): Server[] {
  const locations = read('deploy/frontend/app-locations.conf');
  const text = read('deploy/frontend/nginx.conf').replace(/^\s*#.*$/gm, '');
  const servers: Server[] = [];
  for (let start = text.indexOf('server {'); start >= 0; start = text.indexOf('server {', start + 1)) {
    let depth = 0;
    let end = start;
    for (let index = text.indexOf('{', start); index < text.length; index += 1) {
      if (text[index] === '{') depth += 1;
      if (text[index] === '}' && --depth === 0) {
        end = index;
        break;
      }
    }
    const body = text
      .slice(start, end)
      .replace(/include \/etc\/nginx\/app-locations\.conf;/, locations.replace(/^\s*#.*$/gm, ''));
    const directives = body
      .split(/[;{}]/)
      .map((line) => line.trim().replace(/\s+/g, ' '))
      .filter(Boolean);
    const listen = directives.find((line) => line.startsWith('listen '));
    servers.push({ port: Number(listen?.split(' ')[1]), directives });
  }
  return servers;
}

function server(port: number): Server {
  const found = nginxServers().find((entry) => entry.port === port);
  assert.ok(found, `nginx lauscht auf ${port}`);
  return found;
}

function directive(entry: Server, name: string): string | undefined {
  return entry.directives.find((line) => line.startsWith(`${name} `))?.slice(name.length + 1);
}

/** Wie nginx die Anfrage an das Backend weiterreicht: X-Forwarded-For für /api/. */
function nginxForward(entry: Server, peer: string, forwardedFor: string[]): string {
  const incoming = forwardedFor.join(', ');
  let remote = peer;
  const trusted = entry.directives.filter((line) => line.startsWith('set_real_ip_from ')).map((line) => line.slice(17));
  const fromTrusted = trusted.some((cidr) => cidr.includes('.') && inIPv4Range(peer, cidr));
  if (directive(entry, 'real_ip_header') === 'X-Forwarded-For' && fromTrusted && incoming) {
    // real_ip_recursive off: letzter Eintrag der (zusammengefassten) Header-Zeilen.
    remote = incoming.split(',').at(-1)?.trim() ?? peer;
  }
  const header = entry.directives
    .find((line) => line.startsWith('proxy_set_header X-Forwarded-For '))
    ?.split(' ')
    .at(-1);
  if (header === '$remote_addr') return remote;
  if (header === '$proxy_add_x_forwarded_for') return incoming ? `${incoming}, ${remote}` : remote;
  assert.fail(`unbekannter Wert für X-Forwarded-For: ${header}`);
}

function inIPv4Range(address: string, cidr: string): boolean {
  const [base, bits] = cidr.split('/');
  const toNumber = (ip: string): number => ip.split('.').reduce((sum, part) => sum * 256 + Number(part), 0);
  const mask = bits === undefined ? 32 : Number(bits);
  const shift = 2 ** (32 - mask);
  return Math.floor(toNumber(address) / shift) === Math.floor(toNumber(base) / shift);
}

/** DEV_LOG_TRUST_PROXY des Backends aus docker-compose.yml. */
function composeTrustProxy(): string {
  const match = /DEV_LOG_TRUST_PROXY:\s*"?([^"\n]+)"?/.exec(read('docker-compose.yml'));
  assert.ok(match, 'DEV_LOG_TRUST_PROXY steht in docker-compose.yml');
  return match[1].trim();
}

/** request.ip und request.protocol, wie Express sie im Backend (Absender nginx) bestimmt. */
function backendSees(headers: Record<string, string>): { ip: string | undefined; protocol: string } {
  const app = express();
  const trust = trustProxySetting(composeTrustProxy());
  if (trust) app.set('trust proxy', trust);
  const request = Object.create(app.request) as Request;
  const socket = { remoteAddress: NGINX, encrypted: false };
  Object.defineProperty(request, 'headers', { value: headers });
  Object.defineProperty(request, 'socket', { value: socket });
  Object.defineProperty(request, 'connection', { value: socket });
  return { ip: request.ip, protocol: request.protocol };
}

test('Direktzugriff: gefälschtes X-Forwarded-For wird nicht zur Client-IP', () => {
  const direct = server(8080);
  for (const spoofed of [['1.2.3.4'], ['1.2.3.4, 5.6.7.8'], ['1.2.3.4', '9.9.9.9']]) {
    const forwarded = nginxForward(direct, GATEWAY, spoofed);
    assert.equal(backendSees({ 'x-forwarded-for': forwarded }).ip, GATEWAY, spoofed.join(' | '));
  }
  assert.equal(directive(direct, 'real_ip_header'), undefined, 'Port 8080 übernimmt keine Client-Header');
});

test('Fehlversuchs-Sperre: wechselnde gefälschte IPs ergeben dieselbe Sperr-Adresse', () => {
  const direct = server(8080);
  const sources = new Set(
    Array.from({ length: 20 }, (_, attempt) => {
      const forwarded = nginxForward(direct, GATEWAY, [`203.0.113.${attempt}`]);
      return clientSource(backendSees({ 'x-forwarded-for': forwarded }).ip);
    }),
  );
  assert.deepEqual([...sources], [GATEWAY]);
});

test('Über Caddy: die echte Client-IP bleibt erhalten, je Client eine eigene Sperr-Adresse', () => {
  assert.match(read('deploy/Caddyfile'), /reverse_proxy frontend:8081\b/, 'Caddy nutzt den eigenen Eingang');
  const proxied = server(8081);
  // Caddy ersetzt X-Forwarded-For durch die Client-IP; auch eine Liste oder zweite Zeile nimmt nur den letzten Wert.
  for (const [incoming, client] of [
    [['198.51.100.7'], '198.51.100.7'],
    [['1.2.3.4, 198.51.100.8'], '198.51.100.8'],
    [['1.2.3.4', '198.51.100.9'], '198.51.100.9'],
  ] as const) {
    const forwarded = nginxForward(proxied, CADDY, [...incoming]);
    assert.equal(backendSees({ 'x-forwarded-for': forwarded }).ip, client);
  }
  const ports = read('deploy/compose/ports.aideation.yml');
  assert.doesNotMatch(ports, /:8081/, 'Port 8081 ist nicht nach aussen veröffentlicht');
});

test('Direktzugriff: gefälschtes X-Forwarded-Proto: https wird nicht übernommen', () => {
  const direct = server(8080);
  assert.equal(directive(direct, 'set $forwarded_proto'), '$scheme');
  assert.equal(directive(direct, 'proxy_set_header X-Forwarded-Proto'), '$forwarded_proto');
  // nginx ersetzt den Header durch $scheme (http); das Backend setzt dann kein Secure-Cookie.
  assert.equal(backendSees({ 'x-forwarded-proto': 'http' }).protocol, 'http');
  assert.equal(directive(server(8081), 'set $forwarded_proto'), '$caddy_proto');
  assert.match(read('deploy/frontend/nginx.conf'), /map \$http_x_forwarded_proto \$caddy_proto \{\s*default http;/);
});

test('nginx reicht X-Real-IP, X-Forwarded-Host und Forwarded des Clients nicht weiter', () => {
  for (const port of [8080, 8081]) {
    const entry = server(port);
    for (const header of ['X-Real-IP', 'X-Forwarded-Host', 'Forwarded']) {
      assert.equal(directive(entry, `proxy_set_header ${header}`), '""', `${port}: ${header}`);
    }
  }
});
