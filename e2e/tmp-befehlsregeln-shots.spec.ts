import { type Page, expect, test } from '@playwright/test';

// Temporär: Printscreens für das Benutzerhandbuch (Abschnitt Eigene Befehlsregeln). Nicht committen.
const username = process.env.E2E_USERNAME!;
const password = process.env.E2E_PASSWORD!;
const OUT = 'docs/benutzerhandbuch-dashboard-agents';

async function login(page: Page): Promise<void> {
  await page.addInitScript(() => localStorage.setItem('devlog.welcome.seen', '1'));
  await page.addInitScript(() => localStorage.setItem('devlog.activeProject', 'velowerk'));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'AIdeation' })).toBeVisible();
  await page.getByLabel('Benutzername').fill(username);
  await page.getByLabel('Passwort').fill(password);
  await page.getByRole('button', { name: 'Anmelden' }).click();
  await expect(page.locator('.app-shell')).toBeVisible();
}

test('Rechte-Kategorien: abgelehnte Regel und gespeicherte eigene Kategorie', async ({ page }) => {
  await login(page);
  await page.goto('/#settings');
  const section = page.locator('details', { has: page.getByRole('heading', { name: 'Rechte-Kategorien' }) });
  await expect(section).toBeVisible();
  if (!(await section.evaluate((node) => (node as HTMLDetailsElement).open))) {
    await section.locator('summary').click();
  }
  await section.scrollIntoViewIfNeeded();

  await section.getByRole('button', { name: '+ Kategorie' }).click();
  await section.getByLabel('Name').fill('Datenbank-Hilfen');
  await section.getByLabel('Beschreibung').fill('Lesende Hilfsbefehle für Auftragstests');
  // Verbotene Wrapper-Regel: die Oberfläche zeigt die Meldung des Servers.
  await section.getByLabel(/Befehle \(einer pro Zeile\)/).fill('Bash(timeout:*)');
  await section.getByRole('button', { name: 'Speichern' }).click();
  await expect(section.locator('.wizard-error')).toContainText('timeout');
  await section.locator('form.permission-form').screenshot({ path: `${OUT}/rechte-kategorie-abgelehnt.png` });

  // Zulässige Regeln: Allowlist-Programme, eine Regel pro Zeile.
  await section
    .getByLabel(/Befehle \(einer pro Zeile\)/)
    .fill('Bash(jq:*)\nBash(git log:*)\nBash(npm run lint:*)');
  await section.getByRole('button', { name: 'Speichern' }).click();
  await expect(page.locator('.notice, [role="status"]').filter({ hasText: 'Kategorie gespeichert.' }).first()).toBeVisible();
  const saved = section.locator('li.custom').filter({ hasText: 'Datenbank-Hilfen' });
  await expect(saved).toBeVisible();
  await saved.screenshot({ path: `${OUT}/rechte-kategorie-gespeichert.png` });
  await section.screenshot({ path: `${OUT}/rechte-kategorien-uebersicht.png` });
});
