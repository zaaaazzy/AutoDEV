import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { checkChromium } from './setup-jobs.js';
import { TEMPLATE_FOLDER_ROOT } from './templates.js';

/**
 * Werkzeuge für Browser-Spiele (Projektvorlage „phaser-game“), eingerichtet vom Einrichtungs-Assistenten:
 * Node in passender Version, Chromium für Playwright (Smoke-Test, optische Abnahme) und die npm-Pakete der Vorlage
 * (Phaser, Vite, Vitest …) im npm-Cache, damit das erste Spielprojekt ohne lange Downloads startet.
 * Phaser selbst kommt nicht in AIdeation, sondern als Abhängigkeit ins jeweilige Projekt.
 */

/** Mindestversion von Node: Vite 8 (Vorlage) und Angular 20 brauchen 22.12. */
export const MIN_NODE = { major: 22, minor: 12 } as const;

export function nodeVersionOk(version: string): boolean {
  const [major = 0, minor = 0] = version.replace(/^v/, '').split('.').map(Number);
  return major > MIN_NODE.major || (major === MIN_NODE.major && minor >= MIN_NODE.minor);
}

/** Paket-Angaben (name@bereich) aus dependencies und devDependencies einer package.json. */
export function packageSpecs(packageJson: string): string[] {
  const parsed = JSON.parse(packageJson) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  return Object.entries({ ...parsed.dependencies, ...parsed.devDependencies }).map(
    ([name, range]) => `${name}@${range}`,
  );
}

export type ToolRunner = (command: string, args: string[]) => Promise<{ ok: boolean; output: string }>;

export interface GameToolsResult {
  chromium: boolean;
  cached: boolean;
  notes: string[];
}

/**
 * Lädt Chromium (falls nötig, gleiche Playwright-Version wie AIdeation) und legt die Pakete der Phaser-Vorlage in den
 * npm-Cache. Scheitert ein Teil, steht der Grund in notes; AIdeation selbst läuft auch ohne.
 */
export async function prepareGameTools(
  run: ToolRunner,
  log: (line: string) => void,
  options: {
    platform?: NodeJS.Platform;
    check?: () => Promise<{ installed: boolean }>;
    templateRoot?: string;
  } = {},
): Promise<GameToolsResult> {
  const notes: string[] = [];
  const check = options.check ?? (() => checkChromium());
  let chromium = (await check()).installed;
  if (chromium) {
    log('Chromium für Playwright ist schon installiert.');
  } else {
    log('Lade Chromium für Playwright (Smoke-Test der Spiele, optische Abnahme) …');
    chromium = (await run('npx', ['--no-install', 'playwright', 'install', 'chromium'])).ok;
    if (!chromium) notes.push('Chromium fehlt – später mit „npx playwright install chromium“ nachholen.');
  }
  if ((options.platform ?? process.platform) === 'linux') {
    log('Linux: Fehlen Chromium Systembibliotheken, hilft einmalig „sudo npx playwright install-deps chromium“.');
  }
  let cached = false;
  try {
    const specs = packageSpecs(
      await readFile(join(options.templateRoot ?? TEMPLATE_FOLDER_ROOT, 'phaser-game', 'package.json'), 'utf8'),
    );
    log(`Lege die Pakete der Phaser-Vorlage in den npm-Cache: ${specs.join(', ')}`);
    cached = (await run('npm', ['cache', 'add', ...specs])).ok;
  } catch (error) {
    log(`Phaser-Vorlage nicht lesbar: ${(error as Error).message}`);
  }
  if (!cached) notes.push('Pakete der Phaser-Vorlage nicht vorgeladen – sie kommen beim ersten Spielprojekt.');
  return { chromium, cached, notes };
}
