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

test('Sprint-Board: offenen Auftrag aus der Liste unter dem Board in den Sprint nehmen und wieder herausnehmen', async ({
  page,
  request,
}) => {
  const headers = { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}` };
  const title = `Board-Auftrag ${Date.now()}`;
  const sprint = (
    await (
      await request.post('/api/projects/e2e/sprints', { headers, data: { name: `Board ${Date.now() % 10000}` } })
    ).json()
  ).sprint;
  const order = (await (await request.post('/api/projects/e2e/development', { headers, data: { title } })).json()).item;
  await login(page);
  await page.goto('/#sprints');
  await page.locator('.dt-table tbody tr').filter({ hasText: sprint.name }).locator('.dt-expand').first().click();
  const board = page.locator('.kanban-board').first();
  // Keine Spalte „Offen“ mehr: offene Aufträge stehen unter dem Board.
  await expect(board.locator('.col-open')).toHaveCount(0);
  const open = board.locator('.kanban-pool-card', { hasText: title });
  await expect(open).toBeVisible();
  await open.getByRole('button', { name: 'In den Sprint nehmen' }).click();
  const planned = board.locator('.col-planned .kanban-card', { hasText: title });
  await expect(planned).toBeVisible();
  await expect(planned.locator('.kanban-rank')).toHaveText('1');
  await planned.getByRole('button', { name: 'Aus dem Sprint nehmen' }).click();
  await expect(board.locator('.kanban-pool-card', { hasText: title })).toBeVisible();
  // Der Titel verlinkt auf den Auftrag.
  await board.locator('.kanban-pool-card', { hasText: title }).getByRole('link', { name: title }).click();
  await expect(page).toHaveURL(/#development\/[0-9a-f-]{36}$/);
  await expect(page.locator('.page-heading h1')).toHaveText('Auftrag');
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

test('Auftrag aus dem Sprint nehmen, unter „Besondere Aufmerksamkeit“ finden und löschen', async ({
  page,
  request,
}) => {
  const headers = { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}` };
  const title = `Sprint-Aufgabe ${Date.now()}`;
  const sprint = (
    await (await request.post('/api/projects/e2e/sprints', { headers, data: { name: 'E2E-Sprint' } })).json()
  ).sprint;
  const item = (await (await request.post('/api/projects/e2e/development', { headers, data: { title } })).json()).item;
  await request.patch(`/api/development/${item.id}`, { headers, data: { sprintId: sprint.id } });

  await login(page);
  await page.goto('/#sprints');
  await page.locator('.dt-table tbody tr').filter({ hasText: 'E2E-Sprint' }).locator('.dt-expand').first().click();
  await page
    .locator('.kanban-board .col-planned .kanban-card')
    .filter({ hasText: title })
    .getByRole('button', { name: 'Aus dem Sprint nehmen' })
    .click();
  await expect(page.locator('.kanban-pool-card').filter({ hasText: title })).toBeVisible();

  await page.goto('/#development');
  const card = page.locator('.attention-card').filter({ hasText: title });
  await expect(card).toContainText('Aus Sprint „E2E-Sprint“ genommen');
  await expect(card.getByRole('button', { name: 'Wieder einplanen' })).toBeVisible();
  page.once('dialog', (dialog) => void dialog.accept());
  await card.getByRole('button', { name: 'Löschen' }).click();
  await expect(card).toHaveCount(0);
  await request.delete(`/api/sprints/${sprint.id}`, { headers });
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
  console.log('DEBUG', response.status(), (await response.text()).slice(0, 300));
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

test('App-Grundlagen: Manifest, Symbole und Service Worker', async ({ page, request }) => {
  const manifest = await (await request.get('/manifest.webmanifest')).json();
  expect(manifest.display).toBe('standalone');
  for (const icon of manifest.icons) expect((await request.get(`/${icon.src}`)).ok()).toBeTruthy();
  await login(page);
  const registered = await page.evaluate(async () => Boolean(await navigator.serviceWorker.getRegistration()));
  expect(registered).toBeTruthy();
});
