import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import pg from 'pg';
import { e2eAdminUrl } from './admin-url.js';

const username = process.env.E2E_USERNAME!;
const password = process.env.E2E_PASSWORD!;

// Die Oberfläche lädt bei laufenden Agents alle 3 s nach; von Hand geöffnete Bereiche dürfen dabei nicht zuklappen.
test('Aufklappbereiche bleiben offen, während Agent-Läufe nachladen (Aktionen, Sprint, Aufträge)', async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const headers = { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}` };
  // Läuft je Gerät einmal: Reste eines früheren Laufs entfernen, sonst gäbe es jeden Auftrag doppelt.
  await request.delete('/api/projects/zz-aufklappen', { headers, data: { confirm: 'Zz Aufklappen' } });
  await request.post('/api/projects', {
    headers,
    data: { slug: 'zz-aufklappen', name: 'Zz Aufklappen', repository: join(tmpdir(), 'dev-log-zz-aufklappen') },
  });
  const sprint = (
    await (
      await request.post('/api/projects/zz-aufklappen/sprints', { headers, data: { name: 'Aufklapp-Sprint' } })
    ).json()
  ).sprint;
  await request.patch(`/api/sprints/${sprint.id}`, { headers, data: { status: 'active' } });
  const ids: string[] = [];
  for (const title of ['Läuft gerade', 'Blockiert A', 'Offen B']) {
    const item = (
      await (await request.post('/api/projects/zz-aufklappen/development', { headers, data: { title } })).json()
    ).item;
    ids.push(item.id);
  }
  await request.patch(`/api/development/${ids[0]}`, { headers, data: { sprintId: sprint.id } });
  const url = e2eAdminUrl();
  url.pathname = `/${process.env.E2E_DATABASE ?? 'dev_log_e2e'}`;
  const db = new pg.Client({ connectionString: url.toString() });
  await db.connect();
  await db.query(
    `UPDATE development_items SET status = 'blocked', failure = 'Agent „Tester“ scheiterte:\n\nRot', analysis = '## Ursache\nKaputt.' WHERE id = $1`,
    [ids[1]],
  );
  // Laufender Schritt: die Oberfläche lädt dann alle 3 s die Agent-Läufe nach (wie bei einem echten Auftrag).
  const run = (
    await db.query(
      `INSERT INTO agent_runs (id, project_slug, development_id, status) VALUES (gen_random_uuid(), 'zz-aufklappen', $1, 'running') RETURNING id`,
      [ids[0]],
    )
  ).rows[0].id;
  const agent =
    (await db.query(`SELECT id FROM agents WHERE project_slug = 'zz-aufklappen' LIMIT 1`)).rows[0]?.id ?? null;
  await db.query(
    `INSERT INTO agent_run_steps (run_id, position, agent_id, agent_name, phase, status, output) VALUES ($1, 0, $2, 'Entwickler', 'while_task', 'running', 'x')`,
    [run, agent],
  );
  let tick = 0;
  const ticker = setInterval(
    () =>
      void db
        .query(`UPDATE agent_run_steps SET output = $2 WHERE run_id = $1`, [run, `Ausgabe ${++tick}`])
        .catch(() => {}),
    1000,
  );

  try {
    await page.addInitScript(() => localStorage.setItem('devlog.welcome.seen', '1'));
    await page.goto('/');
    await page.getByLabel('Benutzername').fill(username);
    await page.getByLabel('Passwort').fill(password);
    await page.getByRole('button', { name: 'Anmelden' }).click();

    // 1) Aktionen: Zeile aufklappen, „Details“ (Auftragsdetails) einblenden
    await page.goto('/#actions?project=zz-aufklappen');
    const row = page.locator('.attention-table tbody tr:not(.closed-detail)').first();
    await row.locator('.dt-expand').click();
    const panel = page.locator('.attention-table .closed-detail').first();
    await panel.getByRole('button', { name: 'Details', exact: true }).click();
    await page.waitForTimeout(8_000);
    await expect(panel.locator('.attention-body')).toBeVisible();
    await expect(panel.locator('app-order-detail')).toBeVisible();
    // Unter „Aktionen“: keine Status-/Sprint-/Agent-Zeile in den Auftragsdetails, die Analyse steht nur einmal da.
    await expect(panel.locator('app-order-detail .order-controls')).toHaveCount(0);
    await panel.locator('details.attention-tech summary').click();
    await expect(panel.locator('app-order-detail').getByText('Kaputt.')).toHaveCount(0);
    await expect(panel.locator('details.attention-tech').getByText('Kaputt.')).toHaveCount(1);
    if (process.env.E2E_SCREENSHOT) await panel.screenshot({ path: process.env.E2E_SCREENSHOT });
    // 2) Sprint: „Aufträge hinzufügen“ öffnen
    await page.goto('/#sprints?project=zz-aufklappen');
    const pool = page.locator('details.sprint-pool').first();
    await pool.locator('summary').click();
    await page.waitForTimeout(8_000);
    await expect(pool).toHaveAttribute('open', '');
    // 3) Aufträge: Zeile aufklappen, Zeitleiste öffnen
    await page.goto('/#development?project=zz-aufklappen');
    await page.locator('.dt-table tbody tr').filter({ hasText: 'Offen B' }).locator('.dt-expand').click();
    const timeline = page.locator('details.order-timeline').first();
    await timeline.locator('summary').click();
    await page.waitForTimeout(8_000);
    await expect(timeline).toHaveAttribute('open', '');
    await expect(page.locator('.order-panel')).toHaveCount(1);
  } finally {
    clearInterval(ticker);
    // Ein laufender Agent sperrt das Löschen des Projekts: den nachgebildeten Lauf beenden.
    await db.query("UPDATE agent_runs SET status = 'passed', completed_at = NOW() WHERE id = $1", [run]);
    await db.end();
    // Projekt wieder entfernen und zurück auf „e2e“: Die Auswahl bleibt sonst für die folgenden Tests stehen.
    await page.goto('/#dashboard?project=e2e').catch(() => {});
    await request.delete('/api/projects/zz-aufklappen', { headers, data: { confirm: 'Zz Aufklappen' } });
  }
});
