/**
 * Überbreite messen: welche Elemente über den rechten oder linken Bildschirmrand ragen. Dieselbe Funktion nutzen die
 * Diagnose im Browser (frontend/src/app/core/layout-check.ts, ?layoutcheck) und die visuelle Prüfung des Workers
 * (Playwright, page.evaluate). Deshalb ist sie in sich geschlossen: keine Importe, keine Bezüge nach außen, und die
 * Browser-Typen sind nur hier im Inneren beschrieben (das Backend kennt keine DOM-Typen).
 */
export interface LayoutOffender {
  /** Tag und bis zu zwei Klassen, z. B. „div.card.wide“. */
  element: string;
  left: number;
  right: number;
  fixed: boolean;
  /** Ein Vorfahre schneidet seitlich ab (overflow-x ≠ visible): verursacht kein seitliches Scrollen. */
  clipped: boolean;
  hidden: boolean;
}

export interface LayoutReport {
  screenWidth: number;
  viewportWidth: number;
  innerWidth: number;
  layoutWidth: number;
  documentWidth: number;
  zoom: number | null;
  scrollX: number;
  /** Nur die innersten Verursacher, nicht abgeschnittene zuerst, höchstens 10. */
  offenders: LayoutOffender[];
}

export function measureLayout(): LayoutReport {
  interface Box {
    left: number;
    right: number;
    width: number;
    height: number;
  }
  interface Style {
    overflowX: string;
    visibility: string;
    position: string;
    opacity: string;
  }
  interface Node {
    tagName: string;
    parentElement: Node | null;
    getAttribute(name: string): string | null;
    getBoundingClientRect(): Box;
    contains(other: Node): boolean;
  }
  interface Browser {
    document: {
      body: Node & { querySelectorAll(selector: string): ArrayLike<Node> };
      documentElement: { clientWidth: number; scrollWidth: number };
    };
    screen: { width: number };
    visualViewport?: { width: number; scale: number } | null;
    innerWidth: number;
    scrollX: number;
    getComputedStyle(element: Node): Style;
  }
  const browser = globalThis as unknown as Browser;
  const body = browser.document.body;
  // iOS vergrössert bei Überbreite das Layout selbst – daher gegen die echte Bildschirmbreite messen.
  const viewport = browser.visualViewport ?? null;
  const width = Math.min(browser.screen.width, viewport?.width ?? browser.innerWidth);
  const clippedByAncestor = (element: Node): boolean => {
    for (let parent = element.parentElement; parent && parent !== body; parent = parent.parentElement) {
      if (browser.getComputedStyle(parent).overflowX !== 'visible') return true;
    }
    return false;
  };
  const offenders = Array.from(body.querySelectorAll('*')).filter((element) => {
    const rect = element.getBoundingClientRect();
    if (!rect.width || !rect.height || (rect.right <= width + 0.5 && rect.left >= -0.5)) return false;
    // Ausgeblendete Menüs (z. B. die eingeklappte Navigation) verbreitern nichts.
    return browser.getComputedStyle(element).visibility !== 'hidden';
  });
  // Nur die innersten Verursacher (deren Kinder nicht selbst überstehen).
  const innermost = offenders.filter(
    (element) => !offenders.some((other) => other !== element && element.contains(other)),
  );
  const described = innermost.map((element) => {
    const rect = element.getBoundingClientRect();
    const style = browser.getComputedStyle(element);
    const classes = String(element.getAttribute('class') ?? '')
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .join('.');
    return {
      element: `${element.tagName.toLowerCase()}${classes ? `.${classes}` : ''}`,
      left: Math.round(rect.left),
      right: Math.round(rect.right),
      fixed: style.position === 'fixed',
      clipped: clippedByAncestor(element),
      hidden: style.visibility === 'hidden' || style.opacity === '0',
    };
  });
  return {
    screenWidth: browser.screen.width,
    viewportWidth: Math.round(viewport?.width ?? 0),
    innerWidth: browser.innerWidth,
    layoutWidth: browser.document.documentElement.clientWidth,
    documentWidth: browser.document.documentElement.scrollWidth,
    zoom: viewport ? viewport.scale : null,
    scrollX: Math.round(browser.scrollX),
    offenders: described.sort((a, b) => Number(a.clipped) - Number(b.clipped)).slice(0, 10),
  };
}

/** Seitliches Scrollen: das Dokument ist breiter als das Fenster oder ein Element ragt frei über den Rand. */
export function overflowProblems(report: LayoutReport): string[] {
  const free = report.offenders.filter((offender) => !offender.clipped && !offender.hidden);
  const wider = report.documentWidth > report.layoutWidth + 1;
  if (!wider && !free.length) return [];
  return [
    ...(wider ? [`Dokument ${report.documentWidth}px breit, sichtbar ${report.layoutWidth}px`] : []),
    ...free.map((offender) => `${offender.element} ragt über den Rand (${offender.left}…${offender.right}px)`),
  ];
}

/** Textzeilen für den Diagnose-Kasten im Browser. */
export function layoutLines(report: LayoutReport): string[] {
  const flags = (offender: LayoutOffender): string =>
    [offender.fixed ? 'fixed' : '', offender.clipped ? 'abgeschnitten' : 'FREI', offender.hidden ? 'unsichtbar' : '']
      .filter(Boolean)
      .join(',');
  return [
    `Bildschirm ${report.screenWidth} · sichtbar ${report.viewportWidth} · inner ${report.innerWidth} · Layout ${report.layoutWidth} · Dokument ${report.documentWidth}`,
    `Zoom ${report.zoom === null ? '?' : report.zoom.toFixed(2)} · versetzt ${report.scrollX}px`,
    ...(report.offenders.length
      ? report.offenders.map(
          (offender) => `${offender.element} ${offender.left}…${offender.right} [${flags(offender)}]`,
        )
      : ['Kein Element ragt über den Rand.']),
  ];
}
