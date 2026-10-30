import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const readJson = (name: string) => JSON.parse(readFileSync(join(root, name), 'utf8'));

interface AngularWorkspace {
  projects: Record<string, { architect?: Record<string, { builder: string }> }>;
}

test('angular.json: alle Builder stammen aus @angular/build', () => {
  const angular = readJson('angular.json') as AngularWorkspace;
  const builders: string[] = [];
  for (const project of Object.values(angular.projects)) {
    for (const target of Object.values(project.architect ?? {})) builders.push(target.builder);
  }
  assert.ok(builders.length > 0);
  for (const builder of builders) {
    assert.ok(!builder.startsWith('@angular-devkit/build-angular'), `alter Builder: ${builder}`);
  }
  assert.ok(builders.includes('@angular/build:application'));
  assert.ok(builders.includes('@angular/build:dev-server'));
});

test('package.json: @angular/build deklariert, alter Builder entfernt', () => {
  const pkg = readJson('package.json');
  const all = { ...pkg.dependencies, ...pkg.devDependencies };
  assert.ok(all['@angular/build']);
  assert.equal(all['@angular-devkit/build-angular'], undefined);
});
