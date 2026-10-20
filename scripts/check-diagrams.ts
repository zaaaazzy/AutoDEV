/**
 * Prüft alle ```mermaid-Diagramme in README.md und docs/*.md: Jedes muss mit dem Theme der App fehlerfrei zeichnen.
 * Aufruf: npm run check:diagrams (braucht den Playwright-Browser, wie die E2E-Tests). Optional --shots <ordner>
 * speichert je Diagramm ein Bild zum Ansehen.
 */
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { MERMAID_CONFIG } from '../frontend/src/app/shared/mermaid-config.js';

const root = process.cwd();
const files = [
  'README.md',
  ...readdirSync(join(root, 'docs'))
    .filter((name) => name.endsWith('.md'))
    .map((name) => join('docs', name)),
];
const diagrams = files.flatMap((file) => {
  let text: string;
  try {
    text = readFileSync(join(root, file), 'utf8');
  } catch {
    return [];
  }
  return [...text.matchAll(/```mermaid\n([\s\S]*?)```/g)].map((match, index) => ({
    name: `${file}#${index + 1}`,
    source: match[1] ?? '',
  }));
});
const shotsIndex = process.argv.indexOf('--shots');
const shots = shotsIndex > 0 ? process.argv[shotsIndex + 1] : null;
if (shots) mkdirSync(shots, { recursive: true });

const browser = await chromium.launch(
  process.env.DEV_LOG_CHROMIUM ? { executablePath: process.env.DEV_LOG_CHROMIUM } : {},
);
const page = await browser.newPage({ viewport: { width: 900, height: 800 } });
await page.setContent('<html><body style="margin:0;background:#fafbf8"><div id="out"></div></body></html>');
await page.addScriptTag({ path: join(root, 'node_modules/mermaid/dist/mermaid.min.js') });
let failed = 0;
for (const [index, diagram] of diagrams.entries()) {
  const result = await page.evaluate(
    async ({ source, config, id }) => {
      const api = (
        globalThis as unknown as {
          mermaid: { initialize(c: unknown): void; render(id: string, s: string): Promise<{ svg: string }> };
        }
      ).mermaid;
      api.initialize(config);
      try {
        const { svg } = await api.render(id, source);
        const box = document.getElementById('out')!;
        box.innerHTML = svg;
        return null;
      } catch (error) {
        return error instanceof Error ? error.message.split('\n')[0] : String(error);
      }
    },
    { source: diagram.source, config: MERMAID_CONFIG, id: `d${index}` },
  );
  if (result) {
    failed += 1;
    console.error(`✗ ${diagram.name}: ${result}`);
    continue;
  }
  if (shots) await page.locator('#out').screenshot({ path: join(shots, `${diagram.name.replace(/[/#]/g, '-')}.png`) });
  console.info(`✓ ${diagram.name}`);
}
await browser.close();
console.info(`${diagrams.length - failed} von ${diagrams.length} Diagrammen in Ordnung.`);
process.exitCode = failed ? 1 : 0;
