import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Pool } from 'pg';
import pngjs from 'pngjs';
import type { LayoutReport } from '../core/layout-measure.js';
import { parseChecks } from './acceptance.js';
import {
  basicMatcher,
  type CaptureFn,
  checkLines,
  compareImages,
  confirmMobilePoints,
  DEFAULT_VISUAL_SETTINGS,
  evaluateCapture,
  fitSnapshot,
  hideSecrets,
  judgeFindings,
  KEEP_SNAPSHOTS,
  loginCredentials,
  type PageCapture,
  pageUrl,
  parseEnvFile,
  parsePreviewPages,
  parseVisualSettings,
  previewUrlError,
  pruneSnapshots,
  runVisualStep,
  storeSnapshot,
  UNAVAILABLE,
  withoutQuery,
} from './visual-check.js';

const { PNG } = pngjs;
const ORDER = '0b6f1c7e-1d2a-4c3b-9e8f-112233445566';

/** PNG mit einer Farbe; optional ein Streifen links (Breite in Pixeln) in einer zweiten Farbe. */
function png(width: number, height: number, color: number[], stripe = 0, stripeColor = [255, 0, 0, 255]): Buffer {
  const image = new PNG({ width, height });
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixel = x < stripe ? stripeColor : color;
      image.data.set(pixel, (y * width + x) * 4);
    }
  }
  return PNG.sync.write(image);
}

/** Zufallsrauschen: lässt sich kaum komprimieren (für die 2-MB-Grenze). */
function noise(width: number, height: number): Buffer {
  const image = new PNG({ width, height });
  let seed = 7;
  for (let index = 0; index < image.data.length; index += 1) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    image.data[index] = index % 4 === 3 ? 255 : seed & 0xff;
  }
  return PNG.sync.write(image);
}

const LAYOUT_OK: LayoutReport = {
  screenWidth: 412,
  viewportWidth: 412,
  innerWidth: 412,
  layoutWidth: 412,
  documentWidth: 412,
  zoom: 1,
  scrollX: 0,
  offenders: [],
};

function capture(overrides: Partial<PageCapture> = {}): PageCapture {
  return {
    png: png(4, 4, [255, 255, 255, 255]),
    consoleErrors: [],
    failedResources: [],
    layout: LAYOUT_OK,
    facts: { textLength: 500, media: 1, brokenImages: [], truncated: [] },
    ...overrides,
  };
}

test('Einstellungen: Standardwerte, gültige Angaben und verständliche Fehler', () => {
  assert.deepEqual(parseVisualSettings(null), DEFAULT_VISUAL_SETTINGS);
  const parsed = parseVisualSettings({
    tolerance: 2,
    masks: '.time\n\n.time\n[data-count]',
    aiJudge: true,
    visionModel: 'llava:13b',
    login: {
      path: '/#login',
      userSelector: '#user',
      passwordSelector: '#pass',
      submitSelector: 'button',
      userKey: 'E2E_USERNAME',
      passwordKey: 'E2E_PASSWORD',
    },
  });
  assert.ok(typeof parsed !== 'string');
  assert.equal(parsed.tolerance, 2);
  assert.deepEqual(parsed.masks, ['.time', '[data-count]']);
  assert.equal(parsed.login?.userKey, 'E2E_USERNAME');
  assert.equal(parsed.aiJudge, true);
  assert.match(String(parseVisualSettings({ tolerance: 101 })), /Toleranz/);
  assert.match(String(parseVisualSettings({ aiJudge: 'ja' })), /KI-Urteil/);
  assert.match(
    String(
      parseVisualSettings({
        login: {
          path: '/',
          userSelector: 'a',
          passwordSelector: 'b',
          submitSelector: 'c',
          userKey: 'X Y',
          passwordKey: 'P',
        },
      }),
    ),
    /Login-Schritt/,
  );
});

test('Vorschau-Adresse und Seiten werden geprüft, Pfade an die Adresse gehängt', () => {
  assert.equal(previewUrlError('http://localhost:4200'), null);
  assert.match(String(previewUrlError('ftp://host')), /http/);
  assert.match(String(previewUrlError('http://user:geheim@localhost')), /Zugangsdaten/);
  assert.deepEqual(parsePreviewPages('/\n/#dashboard\n/#dashboard\n'), ['/', '/#dashboard']);
  assert.match(String(parsePreviewPages(['dashboard'])), /Seiten/);
  assert.equal(pageUrl('http://localhost:4200/', '/#dashboard'), 'http://localhost:4200/#dashboard');
  assert.equal(pageUrl('http://localhost:4200/app', '#x'), 'http://localhost:4200/app/#x');
});

test('Test-Login nur aus der .env.example des Projekts', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'visual-'));
  try {
    const login = {
      path: '/',
      userSelector: 'a',
      passwordSelector: 'b',
      submitSelector: 'c',
      userKey: 'APP_USER',
      passwordKey: 'APP_PASS',
    };
    assert.equal(await loginCredentials(folder, login), null);
    await writeFile(join(folder, '.env'), 'APP_USER=echt\nAPP_PASS=echt-geheim\n');
    assert.equal(await loginCredentials(folder, login), null, '.env wird nie gelesen');
    await writeFile(
      join(folder, '.env.example'),
      '# Testwerte\nexport APP_USER="tester"\nAPP_PASS=test-passwort # Kommentar\n',
    );
    assert.deepEqual(await loginCredentials(folder, login), { user: 'tester', password: 'test-passwort' });
    assert.equal(await loginCredentials(folder, null), null);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
  assert.deepEqual(
    [...parseEnvFile("A='x y'\nB=\nkein Eintrag").entries()],
    [
      ['A', 'x y'],
      ['B', ''],
    ],
  );
});

test('Zugangsdaten und Query-Parameter verschwinden aus Texten', () => {
  assert.equal(
    hideSecrets('Login mit test-passwort fehlgeschlagen', ['test-passwort']),
    'Login mit [REDACTED] fehlgeschlagen',
  );
  assert.equal(withoutQuery('http://localhost/api/x?token=abc#frag'), 'http://localhost/api/x');
});

test('Handy: seitliches Scrollen ist ein nicht erfüllter Prüfpunkt, auf dem Desktop wird es nicht geprüft', () => {
  const wide: LayoutReport = {
    ...LAYOUT_OK,
    documentWidth: 520,
    offenders: [{ element: 'table.wide', left: 0, right: 520, fixed: false, clipped: false, hidden: false }],
  };
  const mobile = evaluateCapture('/#dashboard', 'mobile', capture({ layout: wide }));
  const overflow = mobile.find((finding) => finding.check === 'overflow');
  assert.equal(overflow?.met, false);
  assert.equal(overflow?.text, 'Handy · /#dashboard: kein seitliches Scrollen');
  assert.match(overflow?.note ?? '', /table\.wide/);
  assert.equal(
    evaluateCapture('/', 'desktop', capture({ layout: wide })).some((f) => f.check === 'overflow'),
    false,
  );
  // Abgeschnittene Elemente (overflow-x am Vorfahren) verursachen kein Scrollen.
  const clipped = { ...LAYOUT_OK, offenders: [{ ...wide.offenders[0]!, clipped: true }] };
  assert.equal(
    evaluateCapture('/', 'mobile', capture({ layout: clipped })).find((f) => f.check === 'overflow')?.met,
    true,
  );
});

test('Konsolenfehler, fehlgeschlagene Ressourcen, fehlende Bilder und leere Seiten werden nicht erfüllt gemeldet', () => {
  const findings = evaluateCapture(
    '/',
    'desktop',
    capture({
      consoleErrors: ['TypeError: x is undefined'],
      failedResources: ['404 http://localhost/app.css'],
      facts: { textLength: 3, media: 0, brokenImages: ['http://localhost/logo.png'], truncated: ['Sehr langer Titel'] },
    }),
  );
  const byCheck = Object.fromEntries(findings.map((finding) => [finding.check, finding]));
  assert.equal(byCheck.console?.met, false);
  assert.match(byCheck.console?.note ?? '', /TypeError/);
  assert.equal(byCheck.resources?.met, false);
  assert.match(byCheck.resources?.note ?? '', /404 .*app\.css; Bild fehlt: .*logo\.png/);
  assert.equal(byCheck.empty?.met, false);
  // Abgeschnittene Texte: nur zur Ansicht für den Menschen, kein Fehler.
  assert.equal(byCheck.truncated?.manual, true);
  const clean = evaluateCapture('/', 'mobile', capture());
  assert.ok(clean.every((finding) => finding.met));
  const failed = evaluateCapture('/', 'mobile', capture({ png: null, error: 'net::ERR_CONNECTION_REFUSED' }));
  assert.deepEqual(
    failed.map((finding) => [finding.check, finding.met]),
    [['load', false]],
  );
});

test('@@CHECK-Zeilen im Format der Abnahmeprüfung', () => {
  const findings = evaluateCapture('/', 'mobile', capture({ consoleErrors: ['Boom'] }));
  const lines = checkLines(findings);
  assert.ok(lines.every((line) => line.startsWith('@@CHECK {')));
  const parsed = parseChecks(lines.join('\n'));
  assert.equal(parsed.length, findings.length);
  assert.deepEqual(parsed[1], { nr: 2, met: false, manual: false, note: 'Handy · /: keine Konsolenfehler – Boom' });
});

test('Pixel-Vergleich: Anteil geändert und Diff-Bild, auch bei unterschiedlicher Grösse', () => {
  const white = png(10, 10, [255, 255, 255, 255]);
  assert.equal(compareImages(white, white, 0.1).percent, 0);
  const half = compareImages(white, png(10, 10, [255, 255, 255, 255], 5, [0, 0, 0, 255]), 0.1);
  assert.equal(half.percent, 50);
  const diff = PNG.sync.read(half.diff);
  assert.deepEqual([diff.width, diff.height], [10, 10]);
  assert.deepEqual([...diff.data.subarray(0, 4)], [255, 0, 0, 255], 'geänderte Pixel rot');
  // Fast gleiche Farbe liegt unter dem Farbabstand.
  assert.equal(compareImages(white, png(10, 10, [252, 252, 252, 255]), 0.1).percent, 0);
  // Höheres Nachher: der neue Bereich zählt als geändert (gegen Weiss gemischt: schwarz vs. transparent).
  const taller = compareImages(white, png(10, 20, [0, 0, 0, 255]), 0.1, basicMatcher);
  assert.equal(taller.percent, 100);
});

test('Snapshot über der Grenze wird verkleinert oder abgelehnt', () => {
  const small = png(4, 4, [1, 2, 3, 255]);
  assert.deepEqual(fitSnapshot(small), { data: small, resized: false });
  const big = noise(200, 200);
  const fitted = fitSnapshot(big, Math.floor(big.length / 3));
  assert.ok(fitted?.resized);
  assert.ok(fitted.data.length <= Math.floor(big.length / 3));
  assert.ok(PNG.sync.read(fitted.data).width < 200, 'auf halbe (oder kleinere) Grösse');
  assert.equal(fitSnapshot(big, 10), null);
  assert.equal(fitSnapshot(Buffer.alloc(100), 10), null, 'kein PNG');
});

interface Row {
  id: string;
  development_id: string;
  project_slug: string;
  page: string;
  device: string;
  kind: string;
  data: Buffer;
  diff_percent: number | null;
  base_id: string | null;
  created: number;
}

/** Mini-Datenbank für Projekt, Snapshots und Prüfpunkte. */
function fakeDb(project: Record<string, unknown> = {}) {
  const snapshots: Row[] = [];
  const checks: { kind: string; position: number; text: string; status: string; note: string }[] = [];
  const queries: string[] = [];
  let counter = 0;
  const pool = {
    query: async (sql: string, values: unknown[] = []) => {
      queries.push(sql);
      if (sql.includes('FROM projects WHERE slug')) return { rows: [project] };
      if (sql.includes('SELECT id, data FROM visual_snapshots')) {
        const [slug, page, device] = values;
        const rows = snapshots
          .filter(
            (row) => row.project_slug === slug && row.page === page && row.device === device && row.kind === 'shot',
          )
          .sort((a, b) => b.created - a.created);
        return { rows: rows.slice(0, 1).map((row) => ({ id: row.id, data: row.data })) };
      }
      if (sql.includes('INSERT INTO visual_snapshots')) {
        counter += 1;
        const [developmentId, slug, page, device, kind, data, diffPercent, baseId] = values as [
          string,
          string,
          string,
          string,
          string,
          Buffer,
          number | null,
          string | null,
        ];
        const row: Row = {
          id: `snap-${counter}`,
          development_id: developmentId,
          project_slug: slug,
          page,
          device,
          kind,
          data,
          diff_percent: diffPercent,
          base_id: baseId,
          created: counter,
        };
        snapshots.push(row);
        return { rows: [{ id: row.id }] };
      }
      if (sql.includes('DELETE FROM visual_snapshots')) {
        const [slug, page, device, kind, keep] = values as [string, string, string, string, number];
        const old = snapshots
          .filter((row) => row.project_slug === slug && row.page === page && row.device === device && row.kind === kind)
          .sort((a, b) => b.created - a.created)
          .slice(keep);
        for (const row of old) snapshots.splice(snapshots.indexOf(row), 1);
        return { rowCount: old.length, rows: [] };
      }
      if (sql.includes('DELETE FROM acceptance_checks')) {
        checks.splice(0, checks.length, ...checks.filter((check) => check.kind !== 'visual'));
        return { rowCount: 0, rows: [] };
      }
      if (sql.includes('INSERT INTO acceptance_checks')) {
        const [, position, text, status, note] = values as [string, number, string, string, string];
        checks.push({ kind: 'visual', position, text, status, note });
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes('SELECT text, status FROM acceptance_checks')) {
        return { rows: checks.filter((check) => ['manual', 'unmet', 'open'].includes(check.status)) };
      }
      return { rowCount: 0, rows: [] };
    },
  } as unknown as Pool;
  return { pool, snapshots, checks, queries };
}

test('Ablage: pro Seite und Gerät höchstens 3 Stände, zu grosse Bilder werden abgelehnt', async () => {
  const db = fakeDb();
  const base = { developmentId: ORDER, project: 'alpha', page: '/', device: 'mobile' as const, kind: 'shot' as const };
  for (let run = 0; run < 5; run += 1) {
    await storeSnapshot(db.pool, { ...base, data: png(2, 2, [run, 0, 0, 255]) });
  }
  await storeSnapshot(db.pool, { ...base, device: 'desktop', data: png(2, 2, [0, 0, 0, 255]) });
  assert.equal(db.snapshots.filter((row) => row.device === 'mobile').length, KEEP_SNAPSHOTS);
  assert.deepEqual(
    db.snapshots.filter((row) => row.device === 'mobile').map((row) => row.id),
    ['snap-3', 'snap-4', 'snap-5'],
    'die ältesten werden gelöscht',
  );
  assert.equal(db.snapshots.filter((row) => row.device === 'desktop').length, 1);
  assert.equal(await pruneSnapshots(db.pool, { ...base, device: 'mobile' }, 1), 2);
  // Über 2 MB und nicht verkleinerbar (kein gültiges PNG): kommt gar nicht erst in die Datenbank.
  const before = db.snapshots.length;
  const rejected = await storeSnapshot(db.pool, { ...base, data: Buffer.alloc(3 * 1024 * 1024) });
  assert.deepEqual(rejected, { id: null, resized: false, rejected: true });
  assert.equal(db.snapshots.length, before);
});

test('Schritt wird übersprungen ohne Frontend-Kategorie oder ohne Vorschau-Adresse', async () => {
  const db = fakeDb({ url: null, pages: [], settings: {} });
  const backend = await runVisualStep({
    pool: db.pool,
    item: { id: ORDER, projectSlug: 'alpha', category: 'backend' },
    cwd: '/tmp',
    criteria: [],
  });
  assert.equal(backend.exitCode, 0);
  assert.match(backend.output, /übersprungen: kein Frontend/);
  assert.equal(db.queries.length, 0);
  const noUrl = await runVisualStep({
    pool: db.pool,
    item: { id: ORDER, projectSlug: 'alpha', category: 'frontend' },
    cwd: '/tmp',
    criteria: [],
  });
  assert.equal(noUrl.exitCode, 0);
  assert.match(noUrl.output, /übersprungen: keine Vorschau-Adresse/);
});

test('Zeitlimit: Schritt bricht ab, blockiert nicht und meldet „visuelle Prüfung nicht möglich“', async () => {
  const db = fakeDb({ url: 'http://localhost:4200', pages: ['/'], settings: {} });
  let aborted = false;
  const hanging: CaptureFn = ({ signal }) =>
    new Promise(() => {
      signal.addEventListener('abort', () => (aborted = true));
    });
  const result = await runVisualStep({
    pool: db.pool,
    item: { id: ORDER, projectSlug: 'alpha', category: 'fullstack' },
    cwd: '/tmp',
    criteria: [],
    capture: hanging,
    timeoutMs: 30,
  });
  assert.equal(result.exitCode, 0);
  assert.match(result.output, new RegExp(UNAVAILABLE));
  assert.ok(aborted, 'die Aufnahme bekommt den Abbruch mit');
  assert.equal(db.checks.length, 1);
  assert.equal(db.checks[0]?.status, 'manual');
  assert.match(db.checks[0]?.note ?? '', /visuelle Prüfung nicht möglich: Zeitlimit/);
});

test('Zwei Läufe: Aufnahmen je Seite und Gerät, ab dem zweiten mit Diff und Prozent; keine Zugangsdaten im Ergebnis', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'visual-run-'));
  try {
    await writeFile(join(folder, '.env.example'), 'APP_USER=tester\nAPP_PASS=sehr-geheim\n');
    const settings = {
      login: {
        path: '/#login',
        userSelector: 'a',
        passwordSelector: 'b',
        submitSelector: 'c',
        userKey: 'APP_USER',
        passwordKey: 'APP_PASS',
      },
    };
    const db = fakeDb({ url: 'http://localhost:4200', pages: ['/', '/#dashboard'], settings });
    let shade = 255;
    let seenCredentials: unknown = null;
    const fake: CaptureFn = async ({ pages, credentials, onProgress }) => {
      seenCredentials = credentials;
      onProgress?.('Login mit sehr-geheim');
      return pages.flatMap((page) =>
        (['desktop', 'mobile'] as const).map((device) => ({
          page,
          device,
          capture: capture({
            png: png(10, 10, [255, 255, 255, 255], shade === 255 ? 0 : 5, [shade, shade, shade, 255]),
            consoleErrors: device === 'mobile' && page === '/' ? ['Fehler beim Login mit sehr-geheim'] : [],
          }),
        })),
      );
    };
    const progress: string[] = [];
    const item = { id: ORDER, projectSlug: 'alpha', category: 'frontend' };
    const first = await runVisualStep({
      pool: db.pool,
      item,
      cwd: folder,
      criteria: [],
      capture: fake,
      onProgress: (m) => progress.push(m),
    });
    assert.equal(first.exitCode, 0);
    assert.deepEqual(seenCredentials, { user: 'tester', password: 'sehr-geheim' });
    assert.equal(
      db.snapshots.filter((row) => row.kind === 'shot').length,
      4,
      'je Seite ein Desktop- und ein Handy-Bild',
    );
    assert.equal(db.snapshots.filter((row) => row.kind === 'diff').length, 0);
    assert.match(first.output, /erster Stand/);
    shade = 0;
    const second = await runVisualStep({ pool: db.pool, item, cwd: folder, criteria: [], capture: fake });
    const diffs = db.snapshots.filter((row) => row.kind === 'diff');
    assert.equal(diffs.length, 4);
    assert.ok(diffs.every((row) => row.diff_percent === 50));
    const latest = db.snapshots.filter((row) => row.kind === 'shot').slice(-4);
    assert.ok(latest.every((row) => row.diff_percent === 50 && row.base_id));
    assert.match(second.output, /50\.00 % geändert \(über der Toleranz\)/);
    const unmet = db.checks.filter((check) => check.status === 'unmet');
    assert.deepEqual(
      unmet.map((check) => check.text),
      ['Handy · /: keine Konsolenfehler'],
    );
    for (const text of [first.output, second.output, ...progress, ...db.checks.map((check) => check.note)]) {
      assert.ok(!text.includes('sehr-geheim'), `Zugangsdaten in: ${text}`);
    }
    assert.ok(parseChecks(second.output).length >= 8);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test('KI-Urteil: eine Zeile je Akzeptanzkriterium, fehlendes Urteil bleibt für den Menschen offen', () => {
  const findings = judgeFindings('@@CHECK {"nr":1,"met":true,"manual":false,"note":"Knopf sichtbar"}', [
    'Knopf',
    'Farbe',
  ]);
  assert.equal(findings.length, 2);
  assert.deepEqual(
    findings.map((finding) => [finding.text, finding.met, finding.manual]),
    [
      ['KI-Urteil: Knopf', true, false],
      ['KI-Urteil: Farbe', false, true],
    ],
  );
});

test('Manuelle Handy-Prüfpunkte werden nur abgehakt, wenn alle Handy-Prüfungen bestanden sind', async () => {
  const db = fakeDb();
  const good = evaluateCapture('/', 'mobile', capture());
  await confirmMobilePoints(db.pool, ORDER, good);
  assert.equal(db.queries.filter((sql) => sql.includes("status = 'manual'")).length, 1);
  const bad = evaluateCapture('/', 'mobile', capture({ consoleErrors: ['x'] }));
  assert.equal(await confirmMobilePoints(db.pool, ORDER, bad), 0);
  assert.equal(await confirmMobilePoints(db.pool, ORDER, evaluateCapture('/', 'desktop', capture())), 0);
  assert.equal(db.queries.filter((sql) => sql.includes("status = 'manual'")).length, 1);
});
