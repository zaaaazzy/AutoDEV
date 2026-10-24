import { expect, test } from '@playwright/test';

/** Was der Test von der Szene liest (nur Typ, der Code läuft im Browser). */
interface MainSceneView {
  current: { player: { x: number } };
}

test('das Spiel startet, zeichnet in den Canvas und meldet keine Fehler', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));

  await page.goto('/');
  const canvas = page.locator('#game canvas');
  await expect(canvas).toBeVisible();
  const box = await canvas.boundingBox();
  expect(box?.width).toBeGreaterThan(0);
  expect(box?.height).toBeGreaterThan(0);

  // Die Szene läuft und hat schon einige Frames gezeichnet.
  await page.waitForFunction(() => window.game?.scene.isActive('main') && window.game.loop.frame > 10);

  // Bild über Phaser holen (funktioniert mit WebGL und Canvas) und zählen, wie viele Farben darin vorkommen.
  const colors = await page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        window.game!.renderer.snapshot((image) => {
          const source = image as HTMLImageElement;
          const canvas = document.createElement('canvas');
          canvas.width = source.width;
          canvas.height = source.height;
          const context = canvas.getContext('2d')!;
          context.drawImage(source, 0, 0);
          const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
          const seen = new Set<number>();
          for (let index = 0; index < data.length; index += 4 * 97) {
            seen.add((data[index]! << 16) | (data[index + 1]! << 8) | data[index + 2]!);
          }
          resolve(seen.size);
        });
      }),
  );
  // Hintergrund, Raster, Figur, Stern und Text: ein leerer oder einfarbiger Canvas fällt hier auf.
  expect(colors).toBeGreaterThan(3);

  // Pfeiltaste nach rechts bewegt die Figur.
  const playerX = () =>
    page.evaluate(() => (window.game!.scene.getScene('main') as unknown as MainSceneView).current.player.x);
  const before = await playerX();
  await page.keyboard.down('ArrowRight');
  await expect.poll(playerX).toBeGreaterThan(before);
  await page.keyboard.up('ArrowRight');

  expect(errors).toEqual([]);
});
