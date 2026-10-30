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
import { selectCoverage } from './coverage.js';

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

test('splits script arguments and names areas', () => {
  assert.deepEqual(splitArgs(` "src/**/*.test.ts" --x 'a b'`), ['src/**/*.test.ts', '--x', 'a b']);
  assert.equal(areaName('mainty-backend'), 'backend');
  assert.equal(areaName('@mainty/contracts'), 'contracts');
  assert.equal(areaName('@shop/api'), 'backend');
  assert.equal(areaName('shop-ui'), 'frontend');
  // Ohne erkennbaren Bereich bleibt der Name stehen; gespeichert wird er nicht (saveCoverage verwirft mit Grund).
  assert.equal(areaName('tools'), 'tools');
  assert.equal(areaName('builder'), 'builder', '„ui“ nur als ganzer Namensteil');
  assert.equal(areaName('rapid'), 'rapid', '„api“ nur als ganzer Namensteil');
  assert.equal(areaName(''), 'Projekt');
});

test('measured percentages fill the tester report', () => {
  const measured = [
    {
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
    },
  ];
  const reported = {
    summary: 'Tester',
    areas: [
      {
        area: 'backend',
        unit: 0,
        component: 0,
        integration: 0,
        e2e: 0,
        passed: 69,
        failed: 0,
        lines: null,
        statements: null,
        branches: null,
        functions: null,
      },
    ],
  };
  const merged = mergeCoverage(reported, measured)!;
  assert.equal(merged.areas.length, 1);
  assert.equal(merged.areas[0]!.area, 'backend');
  assert.equal(merged.areas[0]!.lines, 84);
  assert.equal(merged.areas[0]!.passed, 69);
  assert.equal(merged.areas[0]!.unit, 64);
  assert.match(merged.summary, /Gemessen von AIdeation/);
  assert.equal(mergeCoverage(null, []), null);
});

test('mergeCoverage vergleicht Schlüssel; eine Messung ohne Bereich fällt beim Speichern mit Grund weg', () => {
  const entry = {
    unit: 5,
    component: 0,
    integration: 0,
    e2e: 0,
    passed: 5,
    failed: 0,
    lines: 80,
    statements: null,
    branches: 70,
    functions: 90,
  };
  const reported = {
    summary: 'Tester',
    areas: [{ ...entry, area: 'frontend', lines: null, branches: null, functions: null }],
    discarded: ['„Projekt“ verworfen: keinem Bereich zuordenbar'],
  };
  const merged = mergeCoverage(reported, [
    { ...entry, area: areaName('shop-web') },
    { ...entry, area: areaName('dev-log') },
  ])!;
  assert.deepEqual(
    merged.areas.map((area) => [area.area, area.lines]),
    [
      ['frontend', 80],
      ['dev-log', 80],
    ],
  );
  assert.deepEqual(merged.discarded, reported.discarded);
  const { areas, discarded } = selectCoverage(merged);
  assert.deepEqual(
    areas.map((area) => area.area),
    ['frontend'],
  );
  assert.equal(discarded.length, 2);
  assert.match(discarded[1]!, /„dev-log“ verworfen: keinem Bereich zuordenbar/);
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
  } finally {
    if (previous === undefined) delete process.env.DEV_LOG_SECRET_KEY;
    else process.env.DEV_LOG_SECRET_KEY = previous;
  }
});
