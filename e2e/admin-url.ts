/**
 * Admin-Zugang der lokalen Datenbank für Tests, die direkt in die Testdatenbank schreiben. Gesetzt von
 * e2e/playwright.config.ts (aus der .env) oder vom Aufrufer; nie ein Standardpasswort als Ersatz.
 */
export function e2eAdminUrl(): URL {
  const url = process.env.E2E_ADMIN_DATABASE_URL?.trim();
  if (!url)
    throw new Error(
      'E2E_ADMIN_DATABASE_URL fehlt – Tests über e2e/playwright.config.ts starten (liest den Zugang aus der .env).',
    );
  return new URL(url);
}
