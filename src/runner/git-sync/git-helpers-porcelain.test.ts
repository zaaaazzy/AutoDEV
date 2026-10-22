import assert from 'node:assert/strict';
import test from 'node:test';
import { porcelainPath } from './git-helpers.js';

test('porcelainPath liest Pfade auch aus der getrimmten ersten Zeile', () => {
  assert.equal(porcelainPath(' M docs/a.md'), 'docs/a.md');
  assert.equal(porcelainPath('M docs/a.md'), 'docs/a.md');
  assert.equal(porcelainPath('MM src/x.ts'), 'src/x.ts');
  assert.equal(porcelainPath('?? docs/tests/neu.md'), 'docs/tests/neu.md');
  assert.equal(porcelainPath('A  Makefile'), 'Makefile');
  assert.equal(porcelainPath('M Makefile'), 'Makefile');
  assert.equal(porcelainPath('R  alt.ts -> neu.ts'), 'neu.ts');
});
