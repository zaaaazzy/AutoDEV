// Egress-Proxy der Agent-Sandbox: einziger Weg aus dem internen Netzwerk aideation-agents (siehe sandbox.ts). Läuft
// als eigener Container aus dem Image aideation-agent (deploy/agent/Dockerfile bündelt diese Datei ohne
// Abhängigkeiten nach /opt/aideation/egress-proxy.mjs). Erlaubt sind nur feste Ziele (host:port): Anthropic-API,
// npm-Registry und Ollama auf dem Host. LAN, Host-Dienste wie die AIdeation-Datenbank und alles andere sind gesperrt.
import { lookup } from 'node:dns/promises';
import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http';
import { isIP, connect, type Socket } from 'node:net';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { defined } from './defined.js';

/** Ziel auf dem Host, das in private Adressen auflösen darf (Docker Desktop bzw. host-gateway). */
const HOST_ALIAS = 'host.docker.internal';

export interface EgressTarget {
  host: string;
  port: number;
}

/** Allowlist aus „host:port,host:port“ (AIDEATION_EGRESS_ALLOW); ungültige Einträge fallen weg. */
export function parseAllowList(value: string | undefined): Set<string> {
  return new Set(
    (value ?? '')
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => /^[a-z0-9.-]+:\d{1,5}$/.test(entry)),
  );
}

/** Ziel aus „host:port“ (CONNECT) bzw. einer absoluten URL (HTTP über Proxy); null bei ungültiger Angabe. */
export function parseTarget(value: string, defaultPort = 443): EgressTarget | null {
  try {
    const url = /^[a-z]+:\/\//i.test(value) ? new URL(value) : new URL(`http://${value}`);
    if (url.username || url.password) return null;
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : /^[a-z]+:\/\//i.test(value) ? 80 : defaultPort));
    if (!host || !Number.isInteger(port) || port < 1 || port > 65_535) return null;
    return { host, port };
  } catch {
    return null;
  }
}

/** Private, lokale und reservierte Adressen (LAN, Loopback, Link-Local, Docker-Netze, CGNAT, IPv6 ULA). */
export function isPrivateAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const [a = 0, b = 0] = address.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (version === 6) {
    const lower = address.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return isPrivateAddress(defined(mapped[1]));
    return lower === '::' || lower === '::1' || /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower) || /^ff/.test(lower);
  }
  return true;
}

/** Darf der Proxy zu diesem Ziel verbinden? Nur exakte Paare host:port aus der Allowlist, nie eine rohe IP. */
export function egressAllowed(target: EgressTarget, allow: ReadonlySet<string>): boolean {
  if (isIP(target.host)) return false;
  return allow.has(`${target.host}:${target.port}`);
}

/**
 * Löst das Ziel auf und prüft die Adressen: Öffentliche Ziele dürfen nicht auf private Adressen zeigen (DNS-Rebinding
 * ins LAN); nur host.docker.internal darf das, und nur mit dem Port aus der Allowlist (Ollama).
 */
export async function resolveTarget(
  target: EgressTarget,
  resolver: (host: string) => Promise<{ address: string }[]> = (host) => lookup(host, { all: true }),
): Promise<string | null> {
  const addresses = await resolver(target.host).catch(() => []);
  if (!addresses.length) return null;
  if (target.host !== HOST_ALIAS && addresses.some(({ address }) => isPrivateAddress(address))) return null;
  return defined(addresses[0]).address;
}

function deny(socket: Socket, status: string): void {
  socket.end(
    `HTTP/1.1 ${status}\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nAIdeation-Sandbox: Ziel gesperrt.\n`,
  );
}

/** Startet den Proxy (CONNECT für HTTPS, absolute URLs für HTTP wie Ollama). */
export function startEgressProxy(
  allow: ReadonlySet<string>,
  port: number,
  resolver?: (host: string) => Promise<{ address: string }[]>,
  log: (line: string) => void = (line) => console.info(line),
): Server {
  const server = createServer(async (request: IncomingMessage, response) => {
    const target = parseTarget(request.url ?? '', 80);
    const address = target && egressAllowed(target, allow) ? await resolveTarget(target, resolver) : null;
    if (!target || !address || !/^http:\/\//i.test(request.url ?? '')) {
      log(`gesperrt: ${request.method} ${target ? `${target.host}:${target.port}` : '?'}`);
      response.writeHead(403, { 'Content-Type': 'text/plain' }).end('AIdeation-Sandbox: Ziel gesperrt.\n');
      return;
    }
    const url = new URL(defined(request.url));
    const upstream = httpRequest(
      {
        host: address,
        port: target.port,
        method: request.method,
        path: `${url.pathname}${url.search}`,
        headers: { ...request.headers, host: url.host },
      },
      (reply) => {
        response.writeHead(reply.statusCode ?? 502, reply.headers);
        reply.pipe(response);
      },
    );
    upstream.on('error', () => response.headersSent || response.writeHead(502).end());
    request.pipe(upstream);
  });
  server.on('connect', async (request: IncomingMessage, client: Socket, head: Buffer) => {
    client.on('error', () => undefined);
    const target = parseTarget(request.url ?? '');
    const address = target && egressAllowed(target, allow) ? await resolveTarget(target, resolver) : null;
    if (!target || !address) {
      log(`gesperrt: CONNECT ${request.url ?? '?'}`);
      deny(client, '403 Forbidden');
      return;
    }
    const upstream = connect(target.port, address, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on('error', () => deny(client, '502 Bad Gateway'));
    client.on('close', () => upstream.destroy());
  });
  server.listen(port, '0.0.0.0');
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const allow = parseAllowList(process.env.AIDEATION_EGRESS_ALLOW);
  const port = Number(process.env.AIDEATION_EGRESS_PORT ?? 3128);
  startEgressProxy(allow, port);
  console.info(`AIdeation-Egress-Proxy auf Port ${port}, erlaubt: ${[...allow].join(', ') || 'nichts'}`);
}
