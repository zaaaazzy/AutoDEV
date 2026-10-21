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

test('Stylesheets: jede Nummer einmal, Reihenfolge in angular.json = Nummernfolge', () => {
  const files = readdirSync(STYLES_DIR).filter((file) => file.endsWith('.css'));
  const numbers = files.map((file) => file.slice(0, 2));
  assert.equal(new Set(numbers).size, numbers.length, `doppelte Nummer: ${numbers.join(', ')}`);

  const listed = build.options.styles.map((path) => path.replace('frontend/src/styles/', ''));
  assert.deepEqual(listed, [...files].sort(), 'angular.json muss alle Dateien in Nummernfolge laden');
});

test('Budget greift auf das globale CSS statt auf (nicht vorhandene) Komponenten-Styles', () => {
  const budgets = build.configurations.production.budgets;
  assert.ok(budgets.some((budget) => budget.type === 'bundle' && budget.name === 'styles' && budget.maximumError));
  assert.ok(!budgets.some((budget) => budget.type === 'anyComponentStyle'));
});
