/**
 * Diagnose für „Seite lässt sich seitlich schieben“: Mit ?layoutcheck in der Adresse zeigt ein Kasten,
 * welche Elemente über den Bildschirmrand ragen (ohne abschneidenden Vorfahren) und ob die Seite gezoomt ist.
 */
function describe(element: Element): string {
  const classes = String(element.getAttribute('class') ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .join('.');
  return `${element.tagName.toLowerCase()}${classes ? `.${classes}` : ''}`;
}

function clippedByAncestor(element: Element): boolean {
  for (let parent = element.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
    const overflow = getComputedStyle(parent).overflowX;
    if (overflow !== 'visible') return true;
  }
  return false;
}

function measure(): string[] {
  // iOS vergrössert bei Überbreite das Layout selbst – daher gegen die echte Bildschirmbreite messen.
  const viewport = globalThis.visualViewport;
  const width = Math.min(globalThis.screen.width, viewport?.width ?? globalThis.innerWidth);
  const offenders = Array.from(document.body.querySelectorAll('*')).filter((element) => {
    const rect = element.getBoundingClientRect();
    if (!rect.width || !rect.height || (rect.right <= width + 0.5 && rect.left >= -0.5)) return false;
    // Ausgeblendete Menüs (z. B. die eingeklappte Navigation) verbreitern nichts.
    return getComputedStyle(element).visibility !== 'hidden';
  });
  // Nur die innersten Verursacher (deren Kinder nicht selbst überstehen).
  const innermost = offenders.filter(
    (element) => !offenders.some((other) => other !== element && element.contains(other)),
  );
  const flags = (element: Element): string => {
    const style = getComputedStyle(element);
    return [
      style.position === 'fixed' ? 'fixed' : '',
      clippedByAncestor(element) ? 'abgeschnitten' : 'FREI',
      style.visibility === 'hidden' || style.opacity === '0' ? 'unsichtbar' : '',
    ]
      .filter(Boolean)
      .join(',');
  };
  return [
    `Bildschirm ${globalThis.screen.width} · sichtbar ${Math.round(viewport?.width ?? 0)} · inner ${globalThis.innerWidth} · Layout ${document.documentElement.clientWidth} · Dokument ${document.documentElement.scrollWidth}`,
    `Zoom ${viewport ? viewport.scale.toFixed(2) : '?'} · versetzt ${Math.round(globalThis.scrollX)}px`,
    ...(innermost.length
      ? innermost
          .sort((a, b) => Number(clippedByAncestor(a)) - Number(clippedByAncestor(b)))
          .slice(0, 10)
          .map((element) => {
            const rect = element.getBoundingClientRect();
            return `${describe(element)} ${Math.round(rect.left)}…${Math.round(rect.right)} [${flags(element)}]`;
          })
      : ['Kein Element ragt über den Rand.']),
  ];
}

export function startLayoutCheck(): void {
  if (!/[?&]layoutcheck\b/.test(globalThis.location.search)) return;
  const box = document.createElement('pre');
  box.setAttribute(
    'style',
    'position:fixed;left:8px;right:8px;bottom:8px;z-index:9999;margin:0;padding:8px;max-height:40vh;overflow:auto;' +
      'background:rgba(20,30,25,.92);color:#fff;font:11px/1.4 ui-monospace,monospace;border-radius:8px;white-space:pre-wrap',
  );
  document.body.append(box);
  const update = (): void => {
    box.textContent = measure().join('\n');
  };
  globalThis.setInterval(update, 1500);
  update();
}
