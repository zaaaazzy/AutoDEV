import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const STYLES_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(STYLES_DIR, '..', '..', '..');

interface Budget {
  type: string;
  name?: string;
  maximumError?: string;
}

const angular = JSON.parse(readFileSync(join(ROOT, 'angular.json'), 'utf8')) as {
  projects: Record<
    string,
    {
      architect: {
        build: { options: { styles: string[] }; configurations: { production: { budgets: Budget[] } } };
      };
    }
  >;
};
const [project] = Object.values(angular.projects);
assert.ok(project, 'angular.json ohne Projekt');
const build = project.architect.build;
const files = readdirSync(STYLES_DIR).filter((file) => file.endsWith('.css'));

/** Selektorliste an den Kommas der obersten Ebene trennen (nicht in :is(…), :not(…)). */
function splitList(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of list) {
    if (char === '(') depth++;
    if (char === ')') depth--;
    if (char === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
    } else current += char;
  }
  return [...parts, current.trim()];
}

/** Selektoren je Medienkontext („“ ohne @media); @keyframes zählen nicht. Reicht für flaches CSS ohne Verschachtelung. */
function selectors(css: string): { context: string; selector: string }[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const found: { context: string; selector: string }[] = [];
  const stack: string[] = [];
  let prelude = '';
  for (const char of text) {
    if (char === '{') {
      const head = prelude.trim().replace(/\s+/g, ' ');
      prelude = '';
      const parent = stack.at(-1) ?? '';
      if (head.startsWith('@')) stack.push(head);
      else {
        if (!parent.startsWith('@keyframes'))
          for (const selector of splitList(head)) found.push({ context: parent, selector });
        stack.push(`rule ${head}`);
      }
    } else if (char === '}') {
      stack.pop();
      prelude = '';
    } else if (char === ';' && !stack.at(-1)?.startsWith('@media') && stack.length) prelude = '';
    else prelude += char;
  }
  return found;
}

test('Stylesheets: jede Nummer einmal, Reihenfolge in angular.json = Nummernfolge', () => {
  const numbers = files.map((file) => file.slice(0, 2));
  assert.equal(new Set(numbers).size, numbers.length, `doppelte Nummer: ${numbers.join(', ')}`);

  const listed = build.options.styles.map((path) => path.replace('frontend/src/styles/', ''));
  assert.deepEqual(listed, [...files].sort(), 'angular.json muss alle Dateien in Nummernfolge laden');
});

test('Stylesheets nach Bereich: jeder Selektor steht je Medienkontext in genau einer Datei', () => {
  const seen = new Map<string, string>();
  const duplicates: string[] = [];
  for (const file of files)
    for (const { context, selector } of selectors(readFileSync(join(STYLES_DIR, file), 'utf8'))) {
      const key = `${context} ${selector}`;
      const first = seen.get(key);
      if (first && first !== file) duplicates.push(`${selector}${context ? ` (${context})` : ''}: ${first} und ${file}`);
      else seen.set(key, file);
    }
  assert.deepEqual(duplicates, [], 'Überschreibungen gehören in die Grundregel des Bereichs, nicht in eine zweite Datei');
});

test('Hilfsklassen .plain-list, .truncate und .row stehen in 01-base.css', () => {
  const base = selectors(readFileSync(join(STYLES_DIR, '01-base.css'), 'utf8')).map(({ selector }) => selector);
  for (const helper of ['.plain-list', '.truncate', '.row']) assert.ok(base.includes(helper), `${helper} fehlt`);
});

test('Budget greift auf das globale CSS statt auf (nicht vorhandene) Komponenten-Styles', () => {
  const budgets = build.configurations.production.budgets;
  assert.ok(budgets.some((budget) => budget.type === 'bundle' && budget.name === 'styles' && budget.maximumError));
  assert.ok(!budgets.some((budget) => budget.type === 'anyComponentStyle'));
});
