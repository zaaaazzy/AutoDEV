import assert from 'node:assert/strict';
import { connect } from 'node:net';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import {
  egressAllowed,
  isPrivateAddress,
  parseAllowList,
  parseTarget,
  resolveTarget,
  startEgressProxy,
} from './egress-proxy.js';
import { egressAllowList } from './sandbox.js';

const allow = parseAllowList(egressAllowList({}));

test('Egress: nur Anthropic-API, npm-Registry und Ollama auf dem Host', () => {
  assert.ok(egressAllowed({ host: 'api.anthropic.com', port: 443 }, allow));
  assert.ok(egressAllowed({ host: 'registry.npmjs.org', port: 443 }, allow));
  assert.ok(egressAllowed({ host: 'host.docker.internal', port: 11434 }, allow));
  // AIdeation-Datenbank (Compose-Name bzw. Port auf dem Host), LAN und andere Host-Dienste sind gesperrt.
  for (const [host, port] of [
    ['db', 5432],
    ['host.docker.internal', 5433],
    ['host.docker.internal', 3000],
    ['127.0.0.1', 5433],
    ['192.168.1.10', 443],
    ['api.anthropic.com', 80],
    ['github.com', 443],
  ] as const) {
    assert.equal(egressAllowed({ host, port }, allow), false, `${host}:${port}`);
  }
});

test('Egress: Ziele aus CONNECT und absoluten URLs, keine Zugangsdaten in der URL', () => {
  assert.deepEqual(parseTarget('api.anthropic.com:443'), { host: 'api.anthropic.com', port: 443 });
  assert.deepEqual(parseTarget('http://host.docker.internal:11434/api/chat', 80), {
    host: 'host.docker.internal',
    port: 11434,
  });
  assert.equal(parseTarget('http://user:pw@host.docker.internal:11434/'), null);
  assert.equal(parseTarget('::::'), null);
});

test('Egress: private Adressen erkannt (DNS-Rebinding ins LAN wird abgewiesen)', async () => {
  for (const address of ['10.1.2.3', '127.0.0.1', '172.20.0.5', '192.168.0.2', '169.254.169.254', '::1', 'fd00::1'])
    assert.ok(isPrivateAddress(address), address);
  for (const address of ['160.79.104.10', '104.16.0.1']) assert.equal(isPrivateAddress(address), false, address);
  const toLan = async () => [{ address: '192.168.1.5' }];
  assert.equal(await resolveTarget({ host: 'api.anthropic.com', port: 443 }, toLan), null);
  // Nur der Host-Alias darf auf eine private Adresse zeigen (Ollama).
  assert.equal(await resolveTarget({ host: 'host.docker.internal', port: 11434 }, toLan), '192.168.1.5');
});

test('Egress-Proxy: CONNECT zu gesperrten Zielen wird mit 403 abgewiesen', async () => {
  const server = startEgressProxy(
    allow,
    0,
    async () => [{ address: '127.0.0.1' }],
    () => undefined,
  );
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  const ask = (line: string): Promise<string> =>
    new Promise((resolve, reject) => {
      const socket = connect(port, '127.0.0.1', () => socket.write(`${line}\r\nHost: x\r\n\r\n`));
      let answer = '';
      socket.on('data', (chunk) => {
        answer += chunk.toString();
        socket.end();
      });
      socket.on('end', () => resolve(answer));
      socket.on('error', reject);
    });
  try {
    assert.match(await ask('CONNECT db:5432 HTTP/1.1'), /^HTTP\/1\.1 403/);
    assert.match(await ask('CONNECT host.docker.internal:5433 HTTP/1.1'), /^HTTP\/1\.1 403/);
    // Erlaubter Name, aber Auflösung ins LAN bzw. auf den Host: gesperrt.
    assert.match(await ask('CONNECT api.anthropic.com:443 HTTP/1.1'), /^HTTP\/1\.1 403/);
    assert.match(await ask('GET http://192.168.1.1/ HTTP/1.1'), /^HTTP\/1\.1 403/);
  } finally {
    server.close();
  }
});
