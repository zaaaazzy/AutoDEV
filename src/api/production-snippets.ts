import type { Request } from 'express';

/**
 * Kopierbare Snippets für die betreute Anwendung (nur Doku – Dev Log greift nicht in deren Code ein).
 * `<TOKEN>` ersetzt die Oberfläche nach dem Erzeugen durch das neue Token.
 */
export const TOKEN_PLACEHOLDER = '<TOKEN>';

/** Adresse, unter der die betreute Anwendung Dev Log erreicht: öffentliche URL bzw. Domain, sonst die der Anfrage. */
export function publicBaseUrl(request: Pick<Request, 'protocol' | 'get'>, environment = process.env): string {
  const configured = environment.DEV_LOG_PUBLIC_URL?.trim().replace(/\/+$/, '');
  if (configured) return configured;
  const domain = environment.DEV_LOG_DOMAIN?.trim();
  if (domain) return `https://${domain}`;
  return `${request.protocol}://${request.get('host') ?? 'localhost:3100'}`;
}

export function ingestEndpoint(baseUrl: string, slug: string, token = TOKEN_PLACEHOLDER): string {
  return `${baseUrl}/api/ingest/${slug}/${token}`;
}

export function browserSnippet(endpoint: string): string {
  return `<script>
  // Dev Log – Fehler aus dem Browser melden (Produktions-Rückkanal)
  (function () {
    var endpoint = '${endpoint}';
    var sent = 0;
    function report(message, stack) {
      if (sent++ >= 20) return; // höchstens 20 Meldungen je Seitenaufruf
      var body = JSON.stringify({
        message: String(message).slice(0, 4000),
        stack: String(stack || '').slice(0, 12000),
        url: location.href,
        source: 'browser'
      });
      // Als Text gesendet: kein CORS-Preflight nötig.
      if (navigator.sendBeacon) navigator.sendBeacon(endpoint, body);
      else fetch(endpoint, { method: 'POST', body: body, mode: 'no-cors', keepalive: true });
    }
    window.onerror = function (message, source, line, column, error) {
      report(message, error && error.stack);
    };
    window.addEventListener('unhandledrejection', function (event) {
      var reason = event.reason || {};
      report(reason.message || reason, reason.stack);
    });
  })();
</script>`;
}

export function nodeSnippet(endpoint: string): string {
  return `// Dev Log – Fehler aus Node melden (Produktions-Rückkanal), Node 18 oder neuer
const DEV_LOG_INGEST_URL = process.env.DEV_LOG_INGEST_URL || '${endpoint}';

function reportToDevLog(error) {
  const body = JSON.stringify({
    message: String((error && error.message) || error).slice(0, 4000),
    stack: String((error && error.stack) || '').slice(0, 12000),
    source: 'node',
  });
  return fetch(DEV_LOG_INGEST_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    signal: AbortSignal.timeout(3000),
  }).catch(() => undefined);
}

process.on('uncaughtException', (error) => {
  console.error(error);
  reportToDevLog(error).finally(() => process.exit(1));
});
process.on('unhandledRejection', (reason) => {
  console.error(reason);
  void reportToDevLog(reason);
});`;
}

/** Anleitung für die Dokumentation (erzeugt, schreibgeschützt). */
export function productionGuide(baseUrl: string, slug: string): string {
  const endpoint = ingestEndpoint(baseUrl, slug);
  return [
    '# Betrieb: Fehler an Dev Log melden',
    '',
    'Dev Log erkennt Fehler der betreuten Anwendung im Betrieb selbst und legt sie als Bug mit Quelle „Betrieb“ an.',
    'Gleiche Fehler werden über einen Fingerabdruck (Meldung und oberster Stack-Frame, ohne Zahlen, IDs und',
    'Zeitstempel) gebündelt und nur gezählt. Einrichten unter [Einstellungen](#settings) → Betrieb.',
    '',
    '## Quellen',
    '',
    '- **Health-URL:** alle 2 Minuten. Zwei Fehlschläge in Folge ergeben den kritischen Bug „Anwendung nicht erreichbar“ und eine Push-Meldung, die Erholung eine Entwarnung. Erlaubt sind nur http(s) auf localhost, im lokalen Netz oder auf einer eigenen Domain (`DEV_LOG_DOMAIN`, `DEV_LOG_OWN_DOMAINS`).',
    '- **Compose-Logs:** alle 15 Minuten und direkt nach jedem erfolgreichen Deploy `docker compose logs --since 15m --no-color <dienste>`. Erkannt werden Stacktraces, `ERROR`-Zeilen und HTTP-5xx.',
    '- **Ingest-Endpunkt:** `POST ' +
      endpoint +
      '` mit JSON `{ "message": "…", "stack": "…", "url": "…" }`, höchstens 16 KB, Rate-Limit 60 Meldungen pro Minute und Absender. Das Token wird unter Einstellungen → Betrieb erzeugt und nur einmal angezeigt; gespeichert ist nur sein Hash.',
    '',
    'Tokens, Passwörter, E-Mail-Adressen und IP-Adressen werden vor dem Speichern maskiert. Zeilen, die ein',
    'Ausschlussmuster enthalten (Textvergleich ohne Gross-/Kleinschreibung), erzeugen kein Ereignis. Ereignisse und',
    'Verlauf werden nach der eingestellten Aufbewahrung (Standard 30 Tage) gelöscht.',
    '',
    '## Schwere, Regression, Deploy-Verdacht',
    '',
    '- Ab 50 Vorkommen pro Stunde oder bei einem Ausfall ist der Bug **kritisch**, ab 10 hoch, ab 3 mittel, sonst niedrig. Die Schwere steigt nur, sie sinkt nie von selbst.',
    '- Tritt der Fehler eines **behobenen** Bugs wieder auf, wird dieser Bug mit dem Hinweis „Regression“ wieder geöffnet – es entsteht kein neuer.',
    '- Mit aktivem automatischem Bugfixing entsteht für einen neuen Betriebs-Bug sofort ein Bug-Auftrag.',
    '- Ereignisse innerhalb von 30 Minuten nach einem Deploy verlinken die Aufträge und Sprints, die seit dem vorigen Deploy erledigt wurden.',
    '',
    '## Snippet für den Browser (`window.onerror`)',
    '',
    'Möglichst früh im `<head>` einfügen. Erlaubt die Content-Security-Policy der Anwendung `connect-src` nur für die',
    'eigene Origin, die Dev-Log-Adresse ergänzen.',
    '',
    '```html',
    browserSnippet(endpoint),
    '```',
    '',
    "## Snippet für Node (`process.on('uncaughtException')`)",
    '',
    'Beim Start der Anwendung laden; die URL am besten als Umgebungsvariable `DEV_LOG_INGEST_URL` setzen.',
    '',
    '```js',
    nodeSnippet(endpoint),
    '```',
    '',
    `\`${TOKEN_PLACEHOLDER}\` durch das Token aus den Einstellungen ersetzen. Nach dem Rotieren antwortet der Endpunkt auf das alte Token mit 401.`,
  ].join('\n');
}
