import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';

const username = process.env.E2E_USERNAME!;
const password = process.env.E2E_PASSWORD!;
const SECTIONS = [
  'dashboard',
  'docs',
  'ideation',
  'development',
  'sprints',
  'bugs',
  'runs',
  'agents',
  'stats',
  'settings',
];

/** Legt einmalig ein Beispielprojekt mit Idee und Auftrag an (über die API, angemeldet per Basic Auth). */
async function seed(request: APIRequestContext): Promise<void> {
  const headers = { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}` };
  const projects = await (await request.get('/api/projects', { headers })).json();
  if (projects.projects.length) return;
  const created = await request.post('/api/projects', {
    headers,
    data: { slug: 'e2e', name: 'E2E-Projekt', repository: join(tmpdir(), 'dev-log-e2e-project') },
  });
  expect(created.ok(), await created.text()).toBeTruthy();
  await request.post('/api/projects/e2e/ideation', { headers, data: { title: 'Dunkelmodus', description: 'Idee' } });
  await request.post('/api/projects/e2e/development', {
    headers,
    data: { title: 'Login-Seite modernisieren mit einem sehr langen Titel, der umbrechen muss', status: 'backlog' },
  });
}

async function login(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Dev Log' })).toBeVisible();
  await page.getByLabel('Benutzername').fill(username);
  await page.getByLabel('Passwort').fill(password);
  await page.getByRole('button', { name: 'Anmelden' }).click();
  await expect(page.locator('.app-shell')).toBeVisible();
}

test.beforeAll(async ({ request }) => seed(request));

test('Login-Seite weist falsche Zugangsdaten ab und meldet richtig an', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Benutzername').fill(username);
  await page.getByLabel('Passwort').fill('falsch');
  await page.getByRole('button', { name: 'Anmelden' }).click();
  await expect(page.getByRole('alert')).toContainText('stimmen nicht');
  await login(page);
  await expect(page.locator('h1')).toHaveText('Dashboard');
});

test('Alle Bereiche laden ohne seitliches Überlaufen', async ({ page }) => {
  await login(page);
  for (const section of SECTIONS) {
    await page.goto(`/#${section}`);
    await expect(page.locator('.page-heading h1')).not.toBeEmpty();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, `Bereich ${section} ragt über den Rand`).toBeLessThanOrEqual(1);
  }
});

test('Navigation: Menü auf dem Handy, Seitenleiste auf dem Desktop', async ({ page, isMobile }) => {
  await login(page);
  if (isMobile) {
    const toggle = page.getByRole('button', { name: 'Menü öffnen' });
    await toggle.click();
    await page.getByRole('link', { name: 'Auftrag' }).click();
    await expect(page.locator('.page-heading h1')).toHaveText('Auftrag');
    await expect(page.getByRole('button', { name: 'Menü öffnen' })).toBeVisible();
  } else {
    await expect(page.locator('.menu-toggle')).toBeHidden();
    await page.locator('.sidebar').hover();
    await page.getByRole('link', { name: 'Auftrag' }).click();
    await expect(page.locator('.page-heading h1')).toHaveText('Auftrag');
  }
});

test('Aufträge erscheinen auf dem Handy als Karten, auf dem Desktop als Tabelle', async ({ page, isMobile }) => {
  await login(page);
  await page.goto('/#development');
  const row = page.locator('.dt-table tbody tr').filter({ hasText: 'Login-Seite modernisieren' });
  await expect(row).toBeVisible();
  const display = await row.evaluate((element) => getComputedStyle(element).display);
  expect(display).toBe(isMobile ? 'grid' : 'table-row');
});

test('Projekt-Assistent öffnet, prüft Eingaben und schließt', async ({ page }) => {
  await login(page);
  await page.locator('.new-project').click();
  const wizard = page.getByRole('dialog', { name: 'Projekt einrichten' });
  await expect(wizard).toBeVisible();
  await expect(wizard.locator('.wizard-step-title')).toHaveText('Wie heißt dein Projekt?');
  await expect(wizard.getByRole('button', { name: /Weiter/ })).toBeDisabled();
  const box = await wizard.boundingBox();
  const viewport = page.viewportSize()!;
  expect(box!.width).toBeLessThanOrEqual(viewport.width);
  await wizard.getByRole('button', { name: 'Schließen' }).click();
  await expect(wizard).toBeHidden();
});

test('Einstellungen: DoR/DoD, Schalter für App und Push, Zwei-Faktor einrichten', async ({ page }) => {
  await login(page);
  await page.goto('/#settings');
  await expect(page.getByLabel('Definition of Done (ein Punkt pro Zeile)')).toBeVisible();
  await expect(page.getByRole('switch', { name: 'Push-Nachrichten' })).toBeVisible();
  await page.getByRole('switch', { name: 'Push-Nachrichten' }).click();
  await expect(page.getByRole('dialog', { name: 'Benachrichtigungen erlauben' })).toBeVisible();
  await page.getByRole('button', { name: 'Später' }).click();
  await page.getByRole('button', { name: 'Einrichten' }).click();
  await expect(page.getByAltText('QR-Code für die Authenticator-App')).toBeVisible();
  await page.getByRole('button', { name: 'Abbrechen' }).click();
});

test('Statistik zeigt Verbrauch nach Bereich, Art, Auftrag und Agent', async ({ page }) => {
  await login(page);
  await page.goto('/#stats');
  for (const heading of ['Nach Bereich', 'Nach Art', 'Schätzung gegen tatsächlich', 'Agents im Vergleich']) {
    await expect(page.getByRole('heading', { name: heading })).toBeVisible();
  }
  await expect(page.locator('.stats-table').first()).toContainText('Login-Seite modernisieren');
});

test('App-Grundlagen: Manifest, Symbole und Service Worker', async ({ page, request }) => {
  const manifest = await (await request.get('/manifest.webmanifest')).json();
  expect(manifest.display).toBe('standalone');
  for (const icon of manifest.icons) expect((await request.get(`/${icon.src}`)).ok()).toBeTruthy();
  await login(page);
  const registered = await page.evaluate(async () => Boolean(await navigator.serviceWorker.getRegistration()));
  expect(registered).toBeTruthy();
});
