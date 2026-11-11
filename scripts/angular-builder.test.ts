import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const readJson = <T>(name: string): T => JSON.parse(readFileSync(join(root, name), 'utf8')) as T;

interface AngularJson {
  projects: Record<string, { architect?: Record<string, { builder: string }> }>;
}

interface PackageJson {
  engines?: { node?: string };
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

interface PackageLock {
  packages: Record<string, { version?: string }>;
}

test('angular.json: alle Builder stammen aus @angular/build', () => {
  const angular = readJson<AngularJson>('angular.json');
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
  const pkg = readJson<PackageJson>('package.json');
  const all = { ...pkg.dependencies, ...pkg.devDependencies };
  assert.ok(all['@angular/build']);
  assert.equal(all['@angular-devkit/build-angular'], undefined);
});

test('package.json: engines verlangt Node >= 22.12', () => {
  assert.equal(readJson<PackageJson>('package.json').engines?.node, '>=22.12');
});

test('Startskripte prüfen die Nebenversion 22.12', () => {
  const sh = readFileSync(join(root, 'start.sh'), 'utf8');
  const ps1 = readFileSync(join(root, 'scripts', 'start.ps1'), 'utf8');
  assert.match(sh, /a===22&&b>=12/);
  assert.match(ps1, /\[version\]'22\.12\.0'/);
});

test('package.json: @angular/cdk folgt der Angular-Hauptversion', () => {
  const { devDependencies } = readJson<PackageJson>('package.json');
  const angularMajor = devDependencies?.['@angular/core']?.match(/^\^?(\d+)\./)?.[1];
  const cdk = devDependencies?.['@angular/cdk'] ?? '';
  assert.ok(angularMajor);
  assert.match(cdk, new RegExp(`^\\^${angularMajor}\\.`), `cdk ist ${cdk}`);
});

test('package-lock.json: Webpack-Kette entfernt, cdk folgt der Angular-Hauptversion', () => {
  const { packages } = readJson<PackageLock>('package-lock.json');
  const stale = Object.keys(packages).filter((path) =>
    /node_modules\/(@angular-devkit\/build-(angular|webpack)|@ngtools\/webpack|webpack(-dev-server|-dev-middleware)?)$/.test(path),
  );
  assert.deepEqual(stale, [], 'Lockfile mit npm neu erzeugen');
  const angularMajor = packages['node_modules/@angular/core']?.version?.split('.')[0];
  const cdk = packages['node_modules/@angular/cdk']?.version ?? '';
  assert.ok(angularMajor);
  assert.match(cdk, new RegExp(`^${angularMajor}\\.`));
});
