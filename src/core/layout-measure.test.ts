import assert from 'node:assert/strict';
import test from 'node:test';
import { type LayoutReport, layoutLines, measureLayout, overflowProblems } from './layout-measure.js';

interface FakeElement {
  tagName: string;
  className: string;
  rect: { left: number; right: number; width: number; height: number };
  style: { overflowX: string; visibility: string; position: string; opacity: string };
  parentElement: FakeElement | null;
  children: FakeElement[];
}

function element(
  tagName: string,
  rect: FakeElement['rect'],
  options: Partial<FakeElement['style']> & { className?: string } = {},
): FakeElement {
  const { className = '', ...style } = options;
  return {
    tagName,
    className,
    rect,
    style: { overflowX: 'visible', visibility: 'visible', position: 'static', opacity: '1', ...style },
    parentElement: null,
    children: [],
  };
}

/** Mini-DOM auf globalThis: so läuft dieselbe Funktion, die Playwright im Browser ausführt. */
function withDom(width: number, tree: FakeElement, run: () => void): void {
  const all: FakeElement[] = [];
  const walk = (node: FakeElement): void => {
    for (const child of node.children) {
      child.parentElement = node;
      all.push(child);
      walk(child);
    }
  };
  walk(tree);
  const api = (node: FakeElement) =>
    Object.assign(node, {
      getAttribute: (name: string) => (name === 'class' ? node.className : null),
      getBoundingClientRect: () => node.rect,
      contains: (other: FakeElement) => {
        for (let current: FakeElement | null = other; current; current = current.parentElement) {
          if (current === node) return true;
        }
        return false;
      },
    });
  [tree, ...all].forEach(api);
  const fake = {
    document: {
      body: Object.assign(tree, { querySelectorAll: () => all }),
      documentElement: { clientWidth: width, scrollWidth: Math.max(width, ...all.map((node) => node.rect.right)) },
    },
    screen: { width },
    visualViewport: { width, scale: 1 },
    innerWidth: width,
    scrollX: 0,
    getComputedStyle: (node: FakeElement) => node.style,
  };
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const key of Object.keys(fake)) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      value: fake[key as keyof typeof fake],
      configurable: true,
      writable: true,
    });
  }
  try {
    run();
  } finally {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
}

test('measureLayout findet die innersten Elemente, die über den Rand ragen', () => {
  const body = element('BODY', { left: 0, right: 412, width: 412, height: 800 });
  const card = element('DIV', { left: 0, right: 600, width: 600, height: 100 }, { className: 'card wide extra' });
  const table = element('TABLE', { left: 0, right: 600, width: 600, height: 80 });
  const scroller = element('DIV', { left: 0, right: 412, width: 412, height: 100 }, { overflowX: 'auto' });
  const code = element('PRE', { left: 0, right: 900, width: 900, height: 50 });
  card.children = [table];
  scroller.children = [code];
  body.children = [card, scroller];
  withDom(412, body, () => {
    const report = measureLayout();
    assert.equal(report.documentWidth, 900);
    assert.deepEqual(
      report.offenders.map((offender) => [offender.element, offender.clipped]),
      [
        ['table', false],
        ['pre', true],
      ],
    );
    assert.deepEqual(overflowProblems(report), [
      'Dokument 900px breit, sichtbar 412px',
      'table ragt über den Rand (0…600px)',
    ]);
  });
});

test('Ohne Überbreite keine Probleme; Diagnosezeilen für den Browser-Kasten', () => {
  const report: LayoutReport = {
    screenWidth: 412,
    viewportWidth: 412,
    innerWidth: 412,
    layoutWidth: 412,
    documentWidth: 412,
    zoom: null,
    scrollX: 0,
    offenders: [{ element: 'div.menu', left: -300, right: 0, fixed: true, clipped: true, hidden: true }],
  };
  assert.deepEqual(overflowProblems(report), []);
  assert.deepEqual(layoutLines(report), [
    'Bildschirm 412 · sichtbar 412 · inner 412 · Layout 412 · Dokument 412',
    'Zoom ? · versetzt 0px',
    'div.menu -300…0 [fixed,abgeschnitten,unsichtbar]',
  ]);
  assert.equal(layoutLines({ ...report, offenders: [] }).at(-1), 'Kein Element ragt über den Rand.');
});
