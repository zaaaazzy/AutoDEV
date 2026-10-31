import type { ErrorRequestHandler, RequestHandler } from 'express';

/** Unbekannte Pfade antworten mit JSON statt mit Express' HTML-Seite – für jede Methode, nicht nur GET. */
export const notFound: RequestHandler = (_request, response) => {
  response.status(404).json({ message: 'Nicht gefunden.' });
};

/**
 * Letzte Middleware: jeder Fehler wird zu einer JSON-Antwort. Stacktrace und Fehlertext gehen nur ins Server-Log,
 * auch ohne NODE_ENV=production (sonst gäbe Express beides als HTML aus).
 */
export const jsonErrors: ErrorRequestHandler = (error: unknown, request, response, next) => {
  if (response.headersSent) return next(error);
  const { status, type } = (error ?? {}) as { status?: unknown; type?: unknown };
  if (type === 'entity.too.large' || status === 413) {
    return void response.status(413).json({ message: 'Die Anfrage ist zu gross. Bitte den Inhalt kürzen.' });
  }
  if (type === 'entity.parse.failed') {
    return void response.status(400).json({ message: 'Die Anfrage enthält kein gültiges JSON.' });
  }
  if (typeof status === 'number' && status >= 400 && status < 500) {
    return void response.status(status).json({ message: 'Die Anfrage ist ungültig.' });
  }
  // Ohne Query-String: dort können Tokens stehen.
  console.error(`[api] ${request.method} ${request.path} fehlgeschlagen:`, error);
  response.status(500).json({ message: 'Interner Fehler. Bitte später erneut versuchen.' });
};
