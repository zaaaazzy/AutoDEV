/**
 * Diagnose für „Seite lässt sich seitlich schieben“: Mit ?layoutcheck in der Adresse zeigt ein Kasten,
 * welche Elemente über den Bildschirmrand ragen (ohne abschneidenden Vorfahren) und ob die Seite gezoomt ist.
 * Die Messung teilt sich die Oberfläche mit der visuellen Prüfung des Workers (src/core/layout-measure.ts).
 */
import { layoutLines, measureLayout } from '../../../../src/core/layout-measure.js';

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
    box.textContent = layoutLines(measureLayout()).join('\n');
  };
  globalThis.setInterval(update, 1500);
  update();
}
