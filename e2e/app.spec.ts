import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type APIRequestContext, expect, type Locator, type Page, test } from '@playwright/test';

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

async function login(page: Page, welcome = false): Promise<void> {
  // Die Begrüßung erscheint sonst in jedem frischen Browser und überdeckt die Seite.
  if (!welcome) await page.addInitScript(() => localStorage.setItem('devlog.welcome.seen', '1'));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'AIdeation' })).toBeVisible();
  await page.getByLabel('Benutzername').fill(username);
  await page.getByLabel('Passwort').fill(password);
  await page.getByRole('button', { name: 'Anmelden' }).click();
  await expect(page.locator('.app-shell')).toBeVisible();
}

/** Sprint-Details: Der aktuelle Sprint steht oben offen, andere klappt ihre Zeile in der Liste auf. */
async function sprintDetail(page: Page, name: string): Promise<Locator> {
  const title = page.locator('.sprint-title h3', { hasText: new RegExp(`^${name}$`) });
  await expect(page.locator('.sprint-current')).toBeVisible();
  const current = page.locator('.sprint-current app-sprint-detail').filter({ has: title });
  if (await current.count()) return current;
  await page.locator('.dt-table tbody tr').filter({ hasText: name }).locator('.dt-expand').first().click();
  return page.locator('.closed-detail app-sprint-detail').filter({ has: title });
}

/** Zeile unter „Aktionen“ (Auftragstabelle) mit diesem Titel. */
function attentionRow(page: Page, title: string): Locator {
  return page.locator('.attention-table tbody tr:not(.closed-detail)').filter({ hasText: title });
}

/** Zeile unter „Aktionen“ aufklappen und den Bereich darunter liefern (Warum, Lösungsvorschlag, Aktionen). */
async function attentionPanel(page: Page, title: string): Promise<Locator> {
  const row = attentionRow(page, title).first();
  const toggle = row.locator('.dt-expand');
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  return row.locator('xpath=following-sibling::tr[1][contains(@class, "closed-detail")]');
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

test('Projekt-Assistent öffnet, prüft Eingaben und schließt', async ({ page, isMobile }) => {
  await login(page);
  if (isMobile) {
    await page.getByRole('button', { name: 'Menü öffnen' }).click();
    await page.getByRole('button', { name: 'Neues Projekt' }).click();
  } else {
    await page.getByRole('button', { name: 'Projekt wechseln' }).click();
    await page.getByRole('button', { name: /Neues Projekt/ }).click();
  }
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
  // Einrichten verlangt das aktuelle Passwort.
  await expect(page.getByRole('button', { name: 'Einrichten' })).toBeDisabled();
  await page.getByLabel('Aktuelles Passwort').fill(password);
  await page.getByRole('button', { name: 'Einrichten' }).click();
  await expect(page.getByAltText('QR-Code für die Authenticator-App')).toBeVisible();
  await page.getByRole('button', { name: 'Abbrechen' }).click();
});

test('Handy-Kopfzeile zeigt Projektwahl und Agents immer', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'nur auf dem Handy');
  await login(page);
  await expect(page.getByRole('combobox', { name: 'Projekt auswählen' }).first()).toBeVisible();
  await page.locator('.mobile-chip').first().click();
  await expect(page.locator('.mobile-agents')).toBeVisible();
  await page.mouse.wheel(0, 2000);
  await expect(page.locator('.mobile-chip').first()).toBeInViewport();
});

test('Dokumentation: Lesen statt Bearbeiten, Suche mit Ausschnitten, Inhaltsverzeichnis zuklappbar', async ({
  page,
  request,
  isMobile,
}) => {
  const headers = { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}` };
  await request.post('/api/projects/e2e/docs', {
    headers,
    data: { title: 'Handbuch Übersicht', content: '# Einstieg\n\nDie Zertifikatsprüfung läuft beim Start.' },
  });
  await login(page);
  await page.goto('/#docs');
  await page.locator('.doc-link', { hasText: 'Handbuch Übersicht' }).click();
  await expect(page.locator('.doc-reader form')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Bearbeiten/ })).toBeVisible();
  // Die Suche ist immer sichtbar; Tippen klappt das Inhaltsverzeichnis mit den Treffern auf.
  await page.getByLabel('Dokumentation durchsuchen').fill('zertifikatspruefung');
  const hit = page.locator('.search-hit', { hasText: 'Handbuch Übersicht' });
  await expect(hit.locator('mark')).toContainText('Zertifikatsprüfung');
  await page.getByLabel('Dokumentation durchsuchen').fill('');
  if (isMobile) {
    // Handy: kein Buch, das Inhaltsverzeichnis klappt nach oben ein.
    await expect(page.locator('.book-toggle')).toBeHidden();
    await page.locator('.docs-index-bar').click();
    await expect(page.locator('.docs-index-body')).toBeHidden();
    await page.locator('.docs-index-bar').click();
    await expect(page.locator('.docs-index-body')).toBeVisible();
  } else {
    await page.getByRole('button', { name: 'Inhaltsverzeichnis zuklappen' }).click();
    await expect(page.locator('.docs-index')).toBeHidden();
    await expect(page.getByLabel('Dokumentation durchsuchen')).toBeVisible();
    await page.getByRole('button', { name: 'Inhaltsverzeichnis öffnen' }).click();
    await expect(page.locator('.docs-index')).toBeVisible();
  }
});

test('Dokumentation → Marketing: Agent-Rechte nur mit Docs-Recht, „Zurück“ verlässt die Seite', async ({
  page,
  browser,
  request,
}) => {
  await login(page);
  // Erst nach der Anmeldung mitschreiben: vorher meldet die Sitzungsprüfung erwartungsgemäß 401.
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto('/#docs');
  await expect(page.locator('.doc-group summary', { hasText: 'Handbücher' })).toBeVisible();
  await page
    .locator('.doc-group', { hasText: 'Marketing' })
    .getByRole('link', { name: 'Agents, Aufgaben und Rechte' })
    .click();
  await expect(page).toHaveURL(/#docs\/marketing\/agent-permissions$/);
  const rows = page.locator('.ap-table tbody tr');
  await expect(rows).toHaveCount(10);
  await expect(rows.filter({ hasText: '(visual_tester)' })).toHaveCount(1);
  await expect(page.locator('.ap-table tr[data-role="developer"] [data-column="files"]')).toContainText(
    'ja, mit Backup',
  );
  await expect(page.locator('.ap-table tr[data-role="reviewer"] [data-column="files"]')).toContainText('nur lesen');
  await expect(page.locator('.ap-diagram svg')).toBeVisible();
  await page.goBack();
  await expect(page.locator('.ap-table')).toHaveCount(0);
  expect(errors).toEqual([]);

  // Ohne Docs-Recht: kein Marketing-Eintrag, und die Adresse zeigt die Seite nicht.
  const admin = { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}` };
  const planner = `planer${Date.now() % 100000}`;
  const plannerPassword = 'planer-passwort-123';
  const created = await request.post('/api/users', {
    headers: admin,
    data: {
      username: planner,
      displayName: 'Paul Planer',
      password: plannerPassword,
      roles: ['plan'],
      projects: ['e2e'],
    },
  });
  expect(created.ok(), await created.text()).toBeTruthy();
  const context = await browser.newContext();
  const plannerPage = await context.newPage();
  await plannerPage.addInitScript(() => localStorage.setItem('devlog.welcome.seen', '1'));
  await plannerPage.goto('/');
  await plannerPage.getByLabel('Benutzername').fill(planner);
  await plannerPage.getByLabel('Passwort').fill(plannerPassword);
  await plannerPage.getByRole('button', { name: 'Anmelden' }).click();
  await plannerPage.goto('/#docs');
  await expect(plannerPage.locator('.doc-group summary', { hasText: 'Handbücher' })).toBeVisible();
  await expect(plannerPage.locator('.doc-group summary', { hasText: 'Marketing' })).toHaveCount(0);
  await plannerPage.goto('/#docs/marketing/agent-permissions');
  await plannerPage.reload();
  await expect(plannerPage.locator('.doc-reader')).toContainText('braucht das Recht „Dokumentation bearbeiten“');
  await expect(plannerPage.locator('.ap-table')).toHaveCount(0);
  await context.close();
});

test('Rollen: Autorin reicht Dokumentänderung ein, Redaktion gibt frei', async ({ page, browser, request }) => {
  const admin = { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}` };
  const author = `autorin${Date.now() % 100000}`;
  const authorPassword = 'autorin-passwort-123';
  const created = await request.post('/api/users', {
    headers: admin,
    data: {
      username: author,
      displayName: 'Anna Autorin',
      password: authorPassword,
      roles: ['docs'],
      projects: ['e2e'],
    },
  });
  expect(created.ok(), await created.text()).toBeTruthy();
  const doc = (
    await (
      await request.post('/api/projects/e2e/docs', {
        headers: admin,
        data: { title: `Rollen-Handbuch ${author}`, content: 'Alter Text.' },
      })
    ).json()
  ).doc;

  // Als Autorin: bearbeiten und einreichen, aber nicht freigeben
  const context = await browser.newContext();
  const authorPage = await context.newPage();
  await authorPage.addInitScript(() => localStorage.setItem('devlog.welcome.seen', '1'));
  await authorPage.goto('/');
  await authorPage.getByLabel('Benutzername').fill(author);
  await authorPage.getByLabel('Passwort').fill(authorPassword);
  await authorPage.getByRole('button', { name: 'Anmelden' }).click();
  await authorPage.goto('/#docs');
  await authorPage.getByLabel('Dokumentation durchsuchen').fill(author);
  await authorPage.locator('.search-hit').first().click();
  await authorPage.getByRole('button', { name: /Bearbeiten/ }).click();
  await authorPage.locator('textarea[name="content"]').fill('Neuer, geprüfter Text.');
  await authorPage.getByRole('button', { name: 'Zur Prüfung einreichen' }).click();
  await expect(authorPage.locator('.revision-card')).toContainText('wartet auf die Redaktion');
  await expect(authorPage.getByRole('button', { name: 'Freigeben' })).toHaveCount(0);
  const forbidden = await authorPage.request.post('/api/users', { data: {} });
  expect(forbidden.status()).toBe(403);
  await context.close();

  // Als Administration: freigeben
  await login(page);
  await page.goto('/#docs');
  await page.getByLabel('Dokumentation durchsuchen').fill(author);
  await page.locator('.search-hit').first().click();
  await expect(page.locator('.diff-added')).toContainText('Neuer, geprüfter Text.');
  await page.getByRole('button', { name: 'Freigeben' }).click();
  await expect(page.locator('.doc-reader article.markdown')).toContainText('Neuer, geprüfter Text.');
  const history = await (await request.get('/api/projects/e2e/doc-revisions', { headers: admin })).json();
  expect(history.revisions.find((revision: { docId: string }) => revision.docId === doc.id).status).toBe('approved');
});

test('Sprint-Popover: Vorschau, Stand im Review-Container starten, Fehler und fehlendes Recht', async ({
  page,
  browser,
  request,
  isMobile,
  baseURL,
}) => {
  test.skip(isMobile, 'Auf dem Handy führt der Sprint-Chip zu den Sprints, ein Popover gibt es dort nicht.');
  const headers = { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}` };
  const stamp = Date.now() % 100000;
  const sprint = (
    await (await request.post('/api/projects/e2e/sprints', { headers, data: { name: `Sprint R${stamp}` } })).json()
  ).sprint;
  const orders: string[] = [];
  for (let index = 1; index <= 6; index++) {
    const created = await request.post('/api/projects/e2e/development', {
      headers,
      data: { title: `Popover-Auftrag ${index} ${stamp}` },
    });
    const id = (await created.json()).item.id;
    orders.push(id);
    await request.patch(`/api/development/${id}`, { headers, data: { sprintId: sprint.id, sprintRank: index } });
  }
  const activated = await request.patch(`/api/sprints/${sprint.id}`, { headers, data: { status: 'active' } });
  expect(activated.ok(), await activated.text()).toBeTruthy();
  await request.patch('/api/projects/e2e', { headers, data: { reviewCommand: 'npm run review' } });
  const merged = { hash: 'a'.repeat(40), subject: 'feat: Warenkorb', date: '2026-10-19', developmentId: null };
  const open = { hash: 'b'.repeat(40), subject: 'wip: Checkout', date: '2026-10-20', developmentId: null };
  const commits = {
    branch: 'sprint',
    commits: [
      { ...merged, merged: true },
      { ...open, merged: false },
    ],
  };
  const reviewUrl = new URL('/health', baseURL).href;
  const slot = (status: string, message: string | null = null) => ({
    slot: 1,
    enabled: true,
    url: reviewUrl,
    status,
    message,
    projectSlug: 'e2e',
    label: open.subject,
    commit: status === 'idle' ? null : open.hash,
    developmentId: null,
    kind: status === 'idle' ? null : 'manual',
    startedAt: null,
  });
  try {
    // Commits und Review-Container nachbilden: ohne Git-Synchronisierung und Docker gibt es beides im Test nicht.
    await page.route('**/api/sprints/*/commits', (route) => route.fulfill({ json: commits }));
    const states: string[] = [];
    await page.route('**/api/review-slots', (route) =>
      route.fulfill({ json: { slots: [slot(states.length > 1 ? states.shift()! : (states[0] ?? 'idle'))] } }),
    );
    const starts: unknown[] = [];
    await page.route('**/api/projects/e2e/review-slots/start', async (route) => {
      starts.push(route.request().postDataJSON());
      await new Promise((resolve) => setTimeout(resolve, 600));
      states.push('requested', 'starting', 'running');
      await route.fulfill({ json: { slot: 1 } });
    });
    await login(page);
    await page.locator('.sprint-pill').hover();
    const popover = page.locator('.sprint-popover');
    await expect(popover).toBeVisible();
    await expect(popover.locator('.popover-title').last()).toHaveText(`Sprint R${stamp} · 0/6 erledigt`);
    await expect(popover.getByRole('list', { name: 'Nächste offene Aufträge' }).locator('li')).toHaveCount(5);
    await expect(popover.locator('.dt-table, .git-tree')).toHaveCount(0);
    const select = popover.locator('select');
    await expect(select.locator('option')).toHaveText([
      'feat: Warenkorb · aaaaaaa · 19.10.2026',
      '◌ wip: Checkout · bbbbbbb · 20.10.2026',
    ]);
    await select.selectOption(open.hash);
    const play = popover.getByRole('button', { name: 'Im Review-Container starten' });
    const opened = page.context().waitForEvent('page');
    await play.click();
    await expect(popover.locator('.review-spinner')).toBeVisible();
    await expect(play).toBeDisabled();
    await expect(popover.getByRole('status')).toContainText(/Stand wird ausgecheckt|Container startet|Review läuft/);
    await expect(popover.getByRole('status')).toContainText('Review läuft', { timeout: 10_000 });
    await expect(popover.locator('.review-spinner')).toHaveCount(0);
    const tab = await opened;
    await expect.poll(() => tab.url(), { timeout: 10_000 }).toBe(reviewUrl);
    expect(starts).toEqual([{ commit: open.hash, label: open.subject, developmentId: null }]);
    await tab.close();

    // Fehler des Servers: Meldung statt Ladeanimation.
    await page.unroute('**/api/projects/e2e/review-slots/start');
    await page.route('**/api/projects/e2e/review-slots/start', (route) =>
      route.fulfill({ status: 409, json: { message: 'Kein Review-Container freigegeben.' } }),
    );
    await play.click();
    await expect(popover.getByRole('alert')).toHaveText('Fehler: Kein Review-Container freigegeben.');
    await expect(popover.locator('.review-spinner')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await page.mouse.move(0, 0);
    await expect(popover).toHaveCount(0);

    // Ohne Recht „run“: Auswahl und Start bleiben gesperrt.
    const planner = `planer${stamp}`;
    await request.post('/api/users', {
      headers,
      data: {
        username: planner,
        displayName: 'Paul Planer',
        password: 'planer-passwort-123',
        roles: ['plan'],
        projects: ['e2e'],
      },
    });
    const context = await browser.newContext();
    const plannerPage = await context.newPage();
    await plannerPage.route('**/api/sprints/*/commits', (route) => route.fulfill({ json: commits }));
    await plannerPage.addInitScript(() => localStorage.setItem('devlog.welcome.seen', '1'));
    await plannerPage.goto('/');
    await plannerPage.getByLabel('Benutzername').fill(planner);
    await plannerPage.getByLabel('Passwort').fill('planer-passwort-123');
    await plannerPage.getByRole('button', { name: 'Anmelden' }).click();
    await plannerPage.locator('.sprint-pill').hover();
    const plannerPopover = plannerPage.locator('.sprint-popover');
    await expect(plannerPopover.locator('select option')).toHaveCount(2);
    await expect(plannerPopover.locator('select')).toBeDisabled();
    await expect(plannerPopover.getByRole('button', { name: 'Im Review-Container starten' })).toBeDisabled();
    await context.close();
  } finally {
    await request.patch('/api/projects/e2e', { headers, data: { reviewCommand: '' } });
    for (const id of orders) await request.delete(`/api/development/${id}`, { headers });
    await request.delete(`/api/sprints/${sprint.id}`, { headers });
  }
});

test('Sprint: offenen Auftrag unter „Aufträge hinzufügen“ in den Sprint nehmen und wieder herausnehmen', async ({
  page,
  request,
}) => {
  const headers = { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}` };
  const title = `Sprint-Liste-Auftrag ${Date.now()}`;
  const sprint = (
    await (
      await request.post('/api/projects/e2e/sprints', { headers, data: { name: `Liste ${Date.now() % 10000}` } })
    ).json()
  ).sprint;
  const order = (await (await request.post('/api/projects/e2e/development', { headers, data: { title } })).json()).item;
  await login(page);
  await page.goto('/#sprints');
  const detail = await sprintDetail(page, sprint.name);
  // Ein leerer Sprint zeigt die Auswahl gleich offen.
  const pool = detail.locator('.sprint-pool');
  await expect(pool.locator('.dt-group').first()).toContainText('Offen');
  await pool.locator('tbody tr', { hasText: title }).getByRole('button', { name: 'In den Sprint nehmen' }).click();
  const planned = detail.locator('.sprint-orders tbody tr', { hasText: title });
  await expect(detail.locator('.sprint-orders .dt-group').first()).toContainText('Geplant');
  await expect(planned.locator('.rank-cell')).toHaveText('1');
  await planned.getByRole('button', { name: 'Aus dem Sprint nehmen' }).click();
  // Aus einem geplanten Sprint genommen ist reine Planung: kein Vermerk, er steht wieder als offener Auftrag zur Wahl.
  await expect(pool.locator('tbody tr', { hasText: title })).toBeVisible();
  await expect(pool.locator('.dt-group', { hasText: 'Abgebrochen' })).toHaveCount(0);
  await request.delete(`/api/development/${order.id}`, { headers });
  await request.delete(`/api/sprints/${sprint.id}`, { headers });
});

test('Begrüßung beim ersten Besuch und interaktive Tour mit Spotlight', async ({ page }) => {
  await login(page, true);
  const welcome = page.getByRole('dialog', { name: /Willkommen bei AIdeation/ });
  await expect(welcome).toBeVisible();
  await welcome.getByRole('button', { name: 'Tour starten' }).click();
  const card = page.locator('.tour-card');
  await expect(card.locator('h3')).toHaveText('Willkommen in AIdeation');
  await card.getByRole('button', { name: 'Weiter' }).click();
  await expect(card.locator('h3')).toHaveText('1 · Ideen sammeln');
  await expect(page).toHaveURL(/#ideation/);
  await expect(page.locator('.tour-spotlight')).toBeVisible();
  await card.getByRole('button', { name: 'Tour beenden' }).click();
  await expect(card).toHaveCount(0);
});

test('Projekt löschen verlangt den genauen Namen', async ({ request }) => {
  const headers = { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}` };
  const slug = `loesch${Date.now() % 100000}`;
  const created = await request.post('/api/projects', {
    headers,
    data: { slug, name: 'Lösch mich', repository: join(tmpdir(), 'dev-log-e2e-project') },
  });
  expect(created.ok(), await created.text()).toBeTruthy();
  expect((await request.delete(`/api/projects/${slug}`, { headers, data: { confirm: 'falsch' } })).status()).toBe(400);
  expect(
    (await request.delete(`/api/projects/${slug}`, { headers, data: { confirm: 'Lösch mich' } })).ok(),
  ).toBeTruthy();
  const projects = await (await request.get('/api/projects', { headers })).json();
  expect(projects.projects.some((project: { slug: string }) => project.slug === slug)).toBe(false);
});

test('Statistik zeigt Verbrauch nach Bereich, Art, Auftrag und Agent', async ({ page }) => {
  await login(page);
  await page.goto('/#stats');
  for (const heading of ['Nach Bereich', 'Nach Art', 'Schätzung gegen tatsächlich', 'Agents im Vergleich']) {
    await expect(page.getByRole('heading', { name: heading })).toBeVisible();
  }
  await expect(page.locator('.stats-table').first()).toContainText('Login-Seite modernisieren');
});

test('Budget: Limits speichern, beim erneuten Öffnen unverändert, Balken auf Dashboard und in der Statistik', async ({
  page,
  request,
}) => {
  const headers = { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}` };
  const invalid = await request.put('/api/projects/e2e/budget', {
    headers,
    data: { limits: { day: { maxTokens: -1 } } },
  });
  expect(invalid.status()).toBe(400);
  await login(page);
  await page.goto('/#settings');
  const budget = page.locator('#budget-settings');
  await expect(budget.getByRole('heading', { name: 'Budget' })).toBeVisible();
  // Standardregeln sind sichtbar, solange keine eigenen gespeichert sind.
  await expect(budget.locator('.routing-rule').first()).toBeVisible();
  await budget.getByLabel('Je Tag: Tokens').fill('5000000');
  await budget.getByLabel('Je Sprint: Kosten in USD').fill('25');
  await budget.getByLabel('Je Auftrag: Tokens').fill('800000');
  await budget.getByRole('button', { name: 'Budget speichern' }).click();
  await expect(page.getByText('Budget gespeichert.')).toBeVisible();

  await page.reload();
  await page.goto('/#settings');
  await expect(budget.getByLabel('Je Tag: Tokens')).toHaveValue('5000000');
  await expect(budget.getByLabel('Je Sprint: Kosten in USD')).toHaveValue('25');
  await expect(budget.getByLabel('Je Auftrag: Tokens')).toHaveValue('800000');

  await page.goto('/#dashboard');
  await expect(page.getByTestId('budget-panel')).toContainText('Heute');
  await page.goto('/#stats');
  await expect(page.getByTestId('stats-budget').getByRole('progressbar').first()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Modell-Routing' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Prompt-Protokoll (Auftragsautor)' })).toBeVisible();

  // Aufräumen: ohne Limits verhält sich der Worker wie bisher.
  const empty = { maxTokens: null, maxCostUsd: null };
  const cleared = await request.put('/api/projects/e2e/budget', {
    headers,
    data: { limits: { day: empty, sprint: empty, order: empty } },
  });
  expect((await cleared.json()).status).toEqual([]);
});

test('Auftrag aus dem Sprint nehmen, unter „Aktionen“ finden und löschen', async ({ page, request }) => {
  const headers = { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}` };
  const title = `Sprint-Aufgabe ${Date.now()}`;
  // Nur aus einem laufenden Sprint genommen wartet ein Auftrag unter „Aktionen“: den aktiven Sprint nutzen bzw. starten.
  const sprints = (
    (await (await request.get('/api/projects/e2e/sprints', { headers })).json()) as {
      sprints: { id: string; name: string; status: string }[];
    }
  ).sprints;
  let sprint = sprints.find((entry) => entry.status === 'active');
  const started = !sprint;
  if (!sprint) {
    sprint = (await (await request.post('/api/projects/e2e/sprints', { headers, data: { name: 'E2E-Sprint' } })).json())
      .sprint as { id: string; name: string; status: string };
    expect((await request.patch(`/api/sprints/${sprint.id}`, { headers, data: { status: 'active' } })).ok()).toBe(true);
  }
  const item = (await (await request.post('/api/projects/e2e/development', { headers, data: { title } })).json()).item;
  await request.patch(`/api/development/${item.id}`, { headers, data: { sprintId: sprint.id } });

  await login(page);
  await page.goto('/#sprints');
  const detail = await sprintDetail(page, sprint.name);
  await detail
    .locator('.sprint-orders tbody tr')
    .filter({ hasText: title })
    .getByRole('button', { name: 'Aus dem Sprint nehmen' })
    .click();
  await expect(detail.locator('.sprint-pool tbody tr').filter({ hasText: title })).toBeVisible();

  // Der Auftrag steht nicht mehr in der Auftragsliste, sondern unter „Aktionen“ (mit Zahl im Menü).
  await page.goto('/#development');
  await expect(page.locator('.dt-table tbody tr').filter({ hasText: title })).toHaveCount(0);
  await page.goto('/#actions');
  // Zeile aufklappen: Grund und Aktionen stehen darin; Löschen fragt im Dialog nach.
  const card = await attentionPanel(page, title);
  await expect(card).toContainText(`Aus Sprint „${sprint.name}“ genommen`);
  await expect(card.getByRole('button', { name: 'Wieder einplanen' })).toBeVisible();
  await card.getByRole('button', { name: 'Löschen' }).click();
  await page
    .getByRole('dialog', { name: 'Auftrag löschen?' })
    .getByRole('button', { name: 'Endgültig löschen' })
    .click();
  await expect(attentionRow(page, title)).toHaveCount(0);
  if (started) {
    await request.patch(`/api/sprints/${sprint.id}`, { headers, data: { status: 'planned' } });
    await request.delete(`/api/sprints/${sprint.id}`, { headers });
  }
});

test('Agent-Aktionen: alle Aktionen nach Agent gruppiert im Assistenten, Details beim Hover, eigene Aktion anlegen', async ({
  page,
}) => {
  const title = `Build prüfen ${test.info().project.name}`;
  await login(page);
  await page.goto('/#dashboard');
  // Keine eigene Quick-Actions-Karte mehr: alles steckt im Menü „Aktionen“ des Assistenten.
  await expect(page.locator('.quick-actions')).toHaveCount(0);
  await page.getByRole('button', { name: 'Aktionen' }).click();
  const menu = page.getByRole('dialog', { name: 'Agent-Aktionen' });
  const search = menu.getByRole('combobox', { name: 'Aktion suchen' });
  await expect(search).toBeFocused();
  // Gruppen: Testläufe und die Standard-Aktionen des Testers.
  const groups = menu.locator('.agent-tasks-group');
  await expect(groups.filter({ hasText: /^Tests$/ })).toHaveCount(1);
  await expect(groups.filter({ hasText: /^Tester$/ })).toHaveCount(1);
  await expect(menu.locator('.agent-task', { hasText: 'Kompletter Test' })).toBeVisible();
  // Hover zeigt die ausführliche Beschreibung mit vollständiger Anweisung, Agent und Befehlen.
  await menu.locator('.agent-task', { hasText: 'Abhängigkeiten prüfen' }).hover();
  const detail = menu.locator('.agent-task-detail');
  await expect(detail).toContainText('Ausgeführt von');
  await expect(detail).toContainText('Tester');
  await expect(detail).toContainText('schlage Updates mit Risiko vor. Nichts installieren.');
  await expect(detail.locator('code', { hasText: 'npm audit' })).toBeVisible();
  // Auch auf dem Handy läuft nichts seitlich aus der Seite.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.mouse.move(0, 0);
  await expect(detail).toHaveCount(0);
  // Ohne Hover (Handy): der Info-Knopf zeigt die Details, ohne die Aktion zu starten.
  const git = menu.locator('.agent-task', { hasText: 'Git-Status zusammenfassen' });
  await git.getByRole('button', { name: 'Details' }).click();
  await expect(detail).toContainText('Nichts ändern.');
  await expect(detail).toContainText('Noch nie gestartet');
  await expect(menu).toBeVisible();
  // Suche filtert über alle Gruppen; Pfeiltaste zeigt die Details per Tastatur.
  // „Docker-Dienste“ statt nur „docker“: „AIdeation neu starten“ erwähnt docker compose ebenfalls.
  await page.mouse.move(0, 0);
  await search.fill('docker-dienste');
  await expect(menu.locator('.agent-task')).toHaveCount(1);
  await expect(menu.locator('.agent-task')).toContainText('Docker-Dienste starten');
  await expect(groups).toHaveText(['Tester']);
  await search.press('ArrowDown');
  await expect(detail).toContainText('docker compose up -d');
  await search.fill(title);
  await expect(menu.getByText('Keine Aktion gefunden.')).toBeVisible();
  await menu.getByRole('button', { name: `+ Neue Aktion „${title}“` }).click();
  await page.getByLabel('Anweisung an den Assistenten').fill('Führe npm run build aus und melde Fehler.');
  await page.getByRole('button', { name: 'Speichern', exact: true }).click();
  const own = menu.locator('.agent-task', { hasText: title });
  await expect(own).toBeVisible();
  page.once('dialog', (dialog) => void dialog.accept());
  await own.hover();
  await own.getByRole('button', { name: 'Löschen' }).click();
  await expect(own).toHaveCount(0);
  await expect(menu.getByRole('link', { name: 'Aktionen verwalten' })).toBeVisible();
});

test('Chat: „@“ wählt den Agent, „/“ verweist mit Bubbles, beim Tippen eingeschränkt', async ({ page }) => {
  await login(page);
  await page.goto('/#dashboard');
  const input = page.getByRole('textbox', { name: /Nachricht – @ für Agent oder Person/ });
  await input.click();
  await input.pressSequentially('@tester');
  await expect(page.locator('.mention-bubble').first()).toContainText('Tester');
  await page.keyboard.press('Enter');
  await expect(page.locator('.composer-chip.agent')).toContainText('Tester');
  await input.pressSequentially('/');
  await expect(page.locator('.mention-bubble')).toHaveCount(6);
  await input.pressSequentially('auf');
  await page.keyboard.press('Enter');
  await expect(input).toHaveValue('/auftrag/');
  await input.pressSequentially('login');
  await expect(page.locator('.mention-bubble').first()).toContainText('Login-Seite modernisieren');
  await page.locator('.mention-bubble').first().click();
  await expect(page.locator('.composer-chip').nth(1)).toContainText('Login-Seite modernisieren');
  await expect(input).toHaveValue('');
});

test('Sprintplanung: Vorschlag mit Begründung und Summen, Aufträge ab- und zuwählen', async ({ page, request }) => {
  const headers = { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}` };
  const title = `Planungs-Auftrag ${test.info().project.name} ${Date.now()}`;
  const order = (
    await (await request.post('/api/projects/e2e/development', { headers, data: { title, priority: 'high' } })).json()
  ).item;
  await login(page);
  await page.goto('/#sprints');
  await page.getByRole('button', { name: /Nächsten Sprint vorschlagen/ }).click();
  const card = page.locator('.sprint-proposal');
  await expect(card.getByRole('heading', { name: /Vorschlag für Sprint/ })).toBeVisible();
  // Platzsparend: zugeklappt nur eine Zeile mit Summen; ein Klick auf den Titel zeigt Tabelle und Aktionen.
  await expect(card.locator('.proposal-summary')).toContainText('Aufträge');
  await expect(card.locator('tbody tr')).toHaveCount(0);
  await card.getByRole('button', { name: /Vorschlag für Sprint/ }).click();
  const row = card.locator('tbody tr', { hasText: title });
  await expect(row).toContainText('Priorität hoch');
  const box = row.getByRole('checkbox');
  await expect(box).toBeChecked();
  const totals = card.locator('.proposal-totals');
  await expect(totals).toContainText('Kosten');
  const before = await totals.textContent();
  await box.uncheck();
  await expect(row).toHaveClass(/unpicked/);
  // Summen aktualisieren sich sofort.
  await expect(totals).not.toHaveText(before ?? '');
  await box.check();
  await expect(card.getByRole('button', { name: 'Übernehmen', exact: true })).toBeVisible();
  await expect(card.getByRole('button', { name: /KI-Kommentar/ })).toBeVisible();

  // Roadmap: 3 vorausberechnete Sprints, ohne dass etwas angelegt wird.
  const sprintList = async () =>
    (
      (await (await request.get('/api/projects/e2e/sprints', { headers })).json()) as {
        sprints: { id: string; status: string }[];
      }
    ).sprints;
  const sprintsBefore = (await sprintList()).length;
  await card.getByRole('button', { name: /Roadmap/ }).click();
  const roadmap = card.locator('.sprint-roadmap');
  await expect(roadmap.getByRole('heading', { name: /die nächsten 3 Sprints/ })).toBeVisible();
  await expect(roadmap.locator('.roadmap-sprint').first()).toContainText(title);
  expect((await sprintList()).length).toBe(sprintsBefore);

  // KI-Kommentar wird beim Worker angefragt; die Auswahl bleibt unverändert. Ohne Pause gibt es nichts freizugeben.
  const asked = await request.post('/api/projects/e2e/sprints/proposal/comment', {
    headers,
    data: { ids: [order.id] },
  });
  expect(asked.status()).toBe(202);
  expect((await asked.json()).comment.status).toBe('requested');
  const resumed = await request.post('/api/projects/e2e/sprints/autopilot/resume', { headers, data: {} });
  expect(resumed.status()).toBe(400);

  // Übernehmen legt den Sprint mit Reihenfolge an (über die API, um andere Tests nicht zu stören).
  const applied = await request.post('/api/projects/e2e/sprints/proposal/apply', {
    headers,
    data: { ids: [order.id], start: false },
  });
  expect(applied.status()).toBe(201);
  const { sprintId } = (await applied.json()) as { sprintId: string };
  expect((await sprintList()).find((sprint) => sprint.id === sprintId)?.status).toBe('planned');
  // Der übernommene Auftrag ist kein Kandidat mehr.
  const next = (await (await request.get('/api/projects/e2e/sprints/proposal', { headers })).json()).proposal as {
    items: { id: string }[];
  };
  expect(next.items.some((item) => item.id === order.id)).toBe(false);
  // Der Kommentar wird beim Übernehmen nicht gespeichert.
  expect((await (await request.get('/api/projects/e2e/sprints/proposal/comment', { headers })).json()).comment).toBe(
    null,
  );
  await request.delete(`/api/sprints/${sprintId}`, { headers });
  await request.delete(`/api/development/${order.id}`, { headers });
});

test('Mandantentrennung: Benutzer sieht nur freigeschaltete Projekte, fremde sind „nicht gefunden“', async ({
  request,
  playwright,
}) => {
  const admin = { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}` };
  const name = `mandant${test.info().project.name}${Date.now() % 100000}`;
  const secret = 'Mandant-Passwort-123';
  const created = (
    await (
      await request.post('/api/users', { headers: admin, data: { username: name, password: secret, roles: ['plan'] } })
    ).json()
  ).user;
  // Eigene Sitzung des Benutzers (Benutzerkonten melden sich per Login an, nicht per Basic-Anmeldung).
  const user = await playwright.request.newContext({ baseURL: test.info().project.use.baseURL });
  try {
    expect((await user.post('/api/login', { data: { username: name, password: secret } })).ok()).toBe(true);
    expect((await (await user.get('/api/projects')).json()).projects).toEqual([]);
    expect((await user.get('/api/projects/e2e/board')).status()).toBe(404);
    expect((await user.get('/api/users')).status()).toBe(403);
    await request.patch(`/api/users/${created.id}`, { headers: admin, data: { projects: ['e2e'] } });
    const visible = (await (await user.get('/api/projects')).json()).projects;
    expect(visible.map((project: { slug: string }) => project.slug)).toEqual(['e2e']);
    expect((await user.get('/api/projects/e2e/board')).status()).toBe(200);
  } finally {
    await user.dispose();
    await request.delete(`/api/users/${created.id}`, { headers: admin });
  }
});

test('Agent-Rechte: jeder Befehl einzeln, fremde Befehle und gefährliche Regeln werden abgelehnt', async ({
  request,
}) => {
  const headers = { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}` };
  const response = await request.post('/api/projects/e2e/agents', {
    headers,
    data: { name: `Rechte-Test ${Date.now()}`, role: 'reviewer', phase: 'while_task' },
  });
  const agent = (await response.json()).agent;
  try {
    expect(agent.allowedCommands).toEqual([]);
    const bad = await request.patch(`/api/agents/${agent.id}`, {
      headers,
      data: { allowedCommands: ['Bash(rm -rf:*)'] },
    });
    expect(bad.status()).toBe(400);
    const ok = await request.patch(`/api/agents/${agent.id}`, {
      headers,
      data: { allowedCommands: ['files:create', 'Bash(git status:*)'], fileScope: ['docs', './src/app/'] },
    });
    const saved = (await ok.json()).agent;
    expect(saved.allowedCommands).toEqual(['files:create', 'Bash(git status:*)']);
    expect(saved.fileScope).toEqual(['docs', 'src/app']);
    // Frühere Sammelregel wird in Anlegen und Ändern aufgeteilt; Ordner ausserhalb des Projekts sind ungültig.
    const legacy = await request.patch(`/api/agents/${agent.id}`, { headers, data: { allowedCommands: ['files'] } });
    expect((await legacy.json()).agent.allowedCommands).toEqual(['files:create', 'files:edit']);
    for (const fileScope of [['../x'], ['/etc'], ['a/../../b']]) {
      expect((await request.patch(`/api/agents/${agent.id}`, { headers, data: { fileScope } })).status()).toBe(400);
    }
    const groups = (await (await request.get('/api/projects/e2e/permission-groups', { headers })).json()).groups;
    const files = groups.find((group: { id: string }) => group.id === 'files');
    expect(files.commands.map((command: { label: string }) => command.label)).toEqual([
      'Dateien anlegen',
      'Dateien ändern',
    ]);
    expect(files.commands.every((command: { help: string }) => command.help.length > 20)).toBeTruthy();
    const rule = await request.post('/api/projects/e2e/permission-groups', {
      headers,
      data: { label: 'Gefährlich', rules: 'Bash(rm -rf:*)' },
    });
    expect(rule.status()).toBe(400);
  } finally {
    await request.delete(`/api/agents/${agent.id}`, { headers });
  }
});

test('Betrieb: Health-URL prüfen, Token erzeugen, Ingest ohne Login, Badge und Verlauf am Bug', async ({
  page,
  request,
  isMobile,
}) => {
  const headers = { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}` };
  for (const healthUrl of ['ftp://localhost/health', 'https://example.com/health']) {
    expect((await request.patch('/api/projects/e2e', { headers, data: { healthUrl } })).status()).toBe(400);
  }
  // Zahlen fallen im Fingerabdruck weg: je Gerät ein eigener Text, damit jeder Lauf einen eigenen Bug anlegt.
  const title = `E2E-Fehler im Betrieb ${isMobile ? 'Handy' : 'Desktop'}`;
  await login(page);
  await page.goto('/#settings');
  const settings = page.locator('#production-settings');
  // Ab dem zweiten Lauf ist ein Token hinterlegt: Rotieren fragt nach.
  page.once('dialog', (dialog) => void dialog.accept());
  await settings.getByRole('button', { name: /Token (erzeugen|rotieren)/ }).click();
  const token = (await settings.getByTestId('ingest-token').textContent())!.trim();
  await expect(settings.getByText(`/api/ingest/e2e/${token}`).first()).toBeAttached();

  // Ein Bug entsteht erst ab drei Vorkommen in 24 Stunden (BUG_THRESHOLD): dreimal melden.
  for (let index = 0; index < 3; index += 1) {
    const anonymous = await request.post(`/api/ingest/e2e/${token}`, {
      headers: { 'Content-Type': 'text/plain' },
      data: JSON.stringify({ message: title, stack: '    at checkout (/app/src/kasse.js:1:1)', source: 'browser' }),
    });
    expect(anonymous.status()).toBe(202);
  }
  expect((await request.post('/api/ingest/e2e/falsches-token-1234567890', { data: '{}' })).status()).toBe(401);
  expect((await request.get('/api/projects')).status()).toBe(401);

  await page.goto('/#bugs');
  const row = page.getByText(title).first();
  await expect(row).toBeVisible();
  // Ereignis und Verlauf bleiben nach dem Aufräumen des Bugs: ein zweiter Lauf am selben Tag zählt mehr.
  await expect(page.getByText(/Betrieb · \d+× seit gestern/).first()).toBeVisible();
  await row.click();
  await expect(page.getByText('Vorkommen je Stunde (48 h)').first()).toBeVisible();
  await expect(page.getByText(/Kein Deploy-Verdacht|Deploy-Verdacht:/).first()).toBeVisible();

  await page.goto('/#dashboard');
  await expect(page.getByTestId('production-tile')).toContainText('Betrieb');

  // Aufräumen: Mit Auto-Bugfix entstand ein Bug-Auftrag, der sonst in den Sprint-Tests des nächsten Geräts liegt.
  const bug = (await (await request.get('/api/projects/e2e/bugs', { headers })).json()).bugs.find(
    (entry: { title: string }) => entry.title.endsWith(title),
  );
  const board = await (await request.get('/api/projects/e2e/board', { headers })).json();
  for (const item of board.development.filter((entry: { bugId: string | null }) => entry.bugId === bug.id)) {
    await request.delete(`/api/development/${item.id}`, { headers });
  }
  await request.delete(`/api/bugs/${bug.id}`, { headers });
});

test('App-Grundlagen: Manifest, Symbole und Service Worker', async ({ page, request }) => {
  const manifest = await (await request.get('/manifest.webmanifest')).json();
  expect(manifest.display).toBe('standalone');
  for (const icon of manifest.icons) expect((await request.get(`/${icon.src}`)).ok()).toBeTruthy();
  await login(page);
  const registered = await page.evaluate(async () => Boolean(await navigator.serviceWorker.getRegistration()));
  expect(registered).toBeTruthy();
});

test('Ideen vorschlagen lassen: Richtung im Dialog vorgeben, Abbrechen startet keinen Lauf', async ({ page }) => {
  await login(page);
  await page.goto('/#ideation');
  const start = page.getByRole('button', { name: /Ideen vorschlagen lassen/ });
  await start.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('Richtung (optional)')).toBeVisible();
  await dialog.getByRole('button', { name: 'Abbrechen' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.visionary-bar .spinner')).toHaveCount(0);

  await start.click();
  await dialog.getByLabel('Richtung (optional)').fill('Fokus auf Onboarding');
  const request = page.waitForRequest(
    (candidate) => candidate.method() === 'POST' && candidate.url().endsWith('/ideation/visionary'),
  );
  await dialog.getByRole('button', { name: 'Ideen vorschlagen lassen' }).click();
  expect((await request).postDataJSON()).toEqual({ comment: 'Fokus auf Onboarding' });
  const bar = page.locator('.visionary-bar').filter({ has: page.locator('.spinner') });
  await expect(bar).toBeVisible();
  await bar.getByRole('button', { name: 'Abbrechen' }).click();
  await expect(bar).toHaveCount(0);
});

test('Sprint abbrechen: Auftrag geht zurück ins Backlog und wartet unter „Aktionen“, der Sprint steht bei den abgebrochenen', async ({
  page,
  request,
}) => {
  const headers = { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}` };
  const title = `Abbruch-Auftrag ${Date.now()}`;
  const name = `Abbruch ${Date.now() % 10000}`;
  const sprint = (await (await request.post('/api/projects/e2e/sprints', { headers, data: { name } })).json()).sprint;
  const item = (await (await request.post('/api/projects/e2e/development', { headers, data: { title } })).json()).item;
  await request.patch(`/api/development/${item.id}`, { headers, data: { sprintId: sprint.id } });

  try {
    await login(page);
    await page.goto('/#sprints');
    const detail = await sprintDetail(page, name);
    page.once('dialog', (dialog) => void dialog.accept());
    await detail.getByRole('button', { name: 'Abbrechen' }).click();
    // Der Sprint steht jetzt bei den abgeschlossenen und abgebrochenen Sprints mit Status „Abgebrochen“.
    const toggle = page.locator('#done-sprints .collapse-toggle');
    if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
    // Die Zeile kann noch aufgeklappt sein (Detailzeile mit demselben Namen): die Tabellenzeile selbst zählt.
    const row = page.locator('#done-sprints .dt-table tbody tr').filter({ hasText: name }).first();
    await expect(row).toContainText('Abgebrochen');
    // Der Auftrag ist nicht mehr geplant, sondern wartet unter „Aktionen“ mit dem Vermerk des Sprints.
    await page.goto('/#actions');
    const card = await attentionPanel(page, title);
    await expect(card).toContainText(`Aus Sprint „${name}“ genommen`);
    await expect(card.getByRole('button', { name: 'Wieder einplanen' })).toBeVisible();
  } finally {
    // Aufräumen auch nach einem Fehlschlag, damit kein Rest den nächsten Test stört. Abgebrochene Sprints sind löschbar.
    await request.delete(`/api/development/${item.id}`, { headers });
    expect((await request.delete(`/api/sprints/${sprint.id}`, { headers })).status()).toBe(204);
  }
});
