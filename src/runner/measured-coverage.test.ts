import assert from 'node:assert/strict';
import test from 'node:test';
import {
  areaName,
  directRunner,
  measureCoverage,
  mergeCoverage,
  parseNodeCoverage,
  splitArgs,
  testRunnerOf,
} from './measured-coverage.js';
import type { CoverageArea } from './coverage.js';

test('reads the node test runner coverage summary', () => {
  const output = `# tests 64\n# pass 63\n# fail 1\n# file | line % | branch % | funcs % | uncovered lines\n# all files                    |  84.02 |    82.64 |   91.78 |\n`;
  assert.deepEqual(parseNodeCoverage(output), {
    lines: 84.02,
    branches: 82.64,
    functions: 91.78,
    passed: 63,
    failed: 1,
  });
  assert.equal(parseNodeCoverage('# tests 3'), null);
});

test('splits script arguments and names areas with the fixed list', () => {
  assert.deepEqual(splitArgs(` "src/**/*.test.ts" --x 'a b'`), ['src/**/*.test.ts', '--x', 'a b']);
  assert.equal(areaName('mainty-backend'), 'backend');
  assert.equal(areaName('@shop/api'), 'backend');
  assert.equal(areaName('shop-ui'), 'frontend');
  assert.equal(areaName('web-clients'), 'frontend');
  assert.equal(areaName('tools'), 'scripts');
  assert.equal(areaName('e2e'), 'e2e');
  assert.equal(areaName('@mainty/contracts'), 'contracts');
  assert.equal(areaName('dev-log'), 'gesamt');
  assert.equal(areaName(null), 'gesamt', 'Messung im Projektordner = gesamt');
  // Kein passender Bereich: null statt eines neuen Namens.
  assert.equal(areaName('builder'), null, '„ui“ nur als ganzer Namensteil');
  assert.equal(areaName('rapid'), null, '„api“ nur als ganzer Namensteil');
  assert.equal(areaName('order-service'), null, '„auftrag“ ist kein Workspace-Bereich');
});

const area = (overrides: Partial<CoverageArea> = {}): CoverageArea => ({
  area: 'backend',
  unit: 64,
  component: 0,
  integration: 0,
  e2e: 0,
  passed: 64,
  failed: 0,
  lines: 84,
  statements: null,
  branches: 82,
  functions: 91,
  ...overrides,
});

test('measured percentages fill the tester report', () => {
  const reported = {
    summary: 'Tester',
    areas: [area({ unit: 3, passed: 69, lines: 10, branches: 5, functions: null })],
  };
  const merged = mergeCoverage(reported, [area()]);
  assert.deepEqual(merged.errors, []);
  assert.equal(merged.report?.areas.length, 1);
  assert.equal(merged.report?.areas[0]!.lines, 84);
  assert.equal(merged.report?.areas[0]!.branches, 82);
  assert.equal(merged.report?.areas[0]!.passed, 69);
  assert.equal(merged.report?.areas[0]!.unit, 3);
  assert.equal(reported.areas[0]!.lines, 10, 'Bericht des Testers wird nicht verändert');
  assert.match(merged.report?.summary ?? '', /Gemessen von AIdeation/);
  assert.deepEqual(mergeCoverage(null, []), { report: null, errors: [] });
});

test('mergeCoverage: ungültige Messung (0 Tests, kein Zweigwert) wird verworfen, die gültige bleibt', () => {
  const merged = mergeCoverage(null, [
    area({ area: 'gesamt' }),
    area({ area: 'frontend', unit: 0, passed: 0 }),
    area({ area: 'scripts', branches: Number.NaN }),
  ]);
  assert.deepEqual(
    merged.report?.areas.map((entry) => entry.area),
    ['gesamt'],
  );
  assert.equal(merged.errors.length, 2);
  assert.match(merged.errors[0]!, /frontend: 0 Testfälle/);
  assert.match(merged.errors[1]!, /scripts: Zweigwert/);
  // Nur ungültige Messungen: kein Bericht.
  assert.equal(mergeCoverage(null, [area({ unit: 0, passed: 0 })]).report, null);
});

test('mergeCoverage vergleicht feste Bereiche: Workspace-Messung ergänzt den gleichnamigen Bereich des Testers', () => {
  const reported = { summary: 'Tester', areas: [area({ area: 'frontend', lines: 10, branches: 5 })] };
  const merged = mergeCoverage(reported, [
    area({ area: areaName('shop-web')!, lines: 80 }),
    area({ area: areaName('dev-log')!, lines: 70 }),
  ]);
  assert.deepEqual(merged.errors, []);
  assert.deepEqual(
    merged.report?.areas.map((entry) => [entry.area, entry.lines]),
    [
      ['frontend', 80],
      ['gesamt', 70],
    ],
  );
});

test('findet den Test-Runner auch hinter „&&“ und über „npm run“', () => {
  const scripts = {
    test: 'npm run build:ui && npm run test:unit',
    'test:unit': 'tsx --test "src/**/*.test.ts" "frontend/src/**/*.spec.ts"',
    'build:ui': 'ng build',
  };
  assert.deepEqual(testRunnerOf('npm run build:ui && tsx --test "a" "b"', {}), {
    binary: 'tsx',
    args: ['a', 'b'],
    setup: [['npm', 'run', 'build:ui']],
  });
  assert.deepEqual(testRunnerOf(scripts.test, scripts), {
    binary: 'tsx',
    args: ['src/**/*.test.ts', 'frontend/src/**/*.spec.ts'],
    setup: [['npm', 'run', 'build:ui']],
  });
  assert.equal(testRunnerOf('vitest run', {}), null);
  // Endlose Verweise brechen ab statt zu hängen.
  assert.equal(testRunnerOf('npm run a', { a: 'npm run a' }), null);
});

test('misst AIdeation selbst: erst vorbereiten, dann mit Abdeckung testen', async () => {
  const { mkdtemp, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'coverage-'));
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'dev-log', scripts: { test: 'npm run build:ui && tsx --test "src/**/*.test.ts"' } }),
  );
  const calls: string[][] = [];
  const areas = await measureCoverage(dir, [['npm', 'test']], async (command) => {
    calls.push(command);
    const output = command.includes('--experimental-test-coverage')
      ? '# pass 5\n# fail 0\n# all files | 80.5 | 70.25 | 90 |\n'
      : '';
    return { exitCode: 0, durationMs: 1, output };
  });
  assert.deepEqual(calls[0], ['npm', 'run', 'build:ui']);
  assert.ok(calls[1]?.includes('--experimental-test-coverage'));
  assert.ok(calls[1]?.includes('src/**/*.test.ts'));
  assert.equal(areas[0]?.lines, 80.5);
  assert.equal(areas[0]?.passed, 5);
});

test('erkennt direkte Aufrufe des Node-Test-Runners aus dem Testplan je Auftrag', () => {
  assert.deepEqual(directRunner(['npx', 'tsx', '--test', 'src/a.test.ts']), { binary: 'tsx', args: ['src/a.test.ts'] });
  assert.deepEqual(directRunner(['npx', '--no-install', 'tsx', '--test', 'a.test.ts']), {
    binary: 'tsx',
    args: ['a.test.ts'],
  });
  assert.deepEqual(directRunner(['node', '--test', '--experimental-test-coverage', 'a.test.js']), {
    binary: 'node',
    args: ['a.test.js'],
  });
  assert.equal(directRunner(['npm', 'test']), null);
  assert.equal(directRunner(['npx', 'playwright', 'test', 'e2e/app.spec.ts']), null);
  // Fremde Wrapper (Shell, env, …) übernimmt die Messung nicht.
  assert.equal(directRunner(['sh', '-c', 'tsx', '--test']), null);
  assert.equal(directRunner(['env', 'X=1', 'tsx', '--test', 'a.test.ts']), null);
});

test('misst die Abdeckung auch für Testbefehle je Auftrag (npx tsx --test <Dateien>)', async () => {
  const { mkdtemp, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'coverage-'));
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'dev-log', scripts: {} }));
  const calls: { command: string[]; env?: NodeJS.ProcessEnv }[] = [];
  const previous = process.env.DEV_LOG_SECRET_KEY;
  process.env.DEV_LOG_SECRET_KEY = 'geheim-coverage';
  try {
    const areas = await measureCoverage(
      dir,
      [
        ['npx', 'tsx', '--test', 'src/runner/a.test.ts', 'src/runner/b.test.ts'],
        ['npx', 'playwright', 'test', 'e2e/app.spec.ts'],
      ],
      async (command, _cwd, options) => {
        calls.push({ command, env: options?.env });
        return { exitCode: 0, durationMs: 1, output: '# pass 4\n# fail 0\n# all files | 75 | 60 | 80 |\n' };
      },
    );
    assert.equal(calls.length, 1, 'Playwright wird nicht gemessen');
    assert.deepEqual(calls[0]!.command.slice(0, 6), [
      'npm',
      'exec',
      '--',
      'tsx',
      '--test',
      '--experimental-test-coverage',
    ]);
    assert.deepEqual(calls[0]!.command.slice(-2), ['src/runner/a.test.ts', 'src/runner/b.test.ts']);
    assert.equal(calls[0]!.env?.DEV_LOG_SECRET_KEY, undefined, 'gefiltertes Environment');
    assert.ok(calls[0]!.env?.PATH);
    assert.equal(areas[0]?.lines, 75);
    assert.equal(areas[0]?.passed, 4);
    assert.equal(areas[0]?.area, 'gesamt', 'feste Bereichsnamen, nicht der Paketname');
  } finally {
    if (previous === undefined) delete process.env.DEV_LOG_SECRET_KEY;
    else process.env.DEV_LOG_SECRET_KEY = previous;
  }
});
