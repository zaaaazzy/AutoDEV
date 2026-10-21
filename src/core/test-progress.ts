/**
 * Fortschritt eines laufenden Testschritts aus seiner bisherigen Ausgabe, für die Live-Anzeige unter „Testläufe“:
 * „13 von 28 Tests · 12 ✓ · 1 ✗ · gerade: Sprints: anlegen …“. Erkennt Playwright (Reporter „list“) und TAP
 * (node --test); sonst eine kurze Beschreibung, was gerade passiert.
 */
export interface StepProgress {
  /** Eine Zeile für die Anzeige. */
  text: string;
  done: number;
  /** Gesamtzahl, falls bekannt (Playwright meldet sie vorab, TAP erst am Ende). */
  total: number | null;
  failed: number;
}

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

export function stepProgress(output: string): StepProgress {
  const text = output.replace(ANSI, '');
  // Playwright, Reporter „list“: „Running 28 tests using 1 worker“, dann je Test „  ✓  13 [desktop] › datei:zeile › Titel (1.2s)“.
  const running = /Running (\d+) tests? using/.exec(text);
  if (running) {
    const total = Number(running[1]);
    const lines = [
      ...text.matchAll(
        /^\s+([✓✘-])\s+\d+\s+(?:\[[^\]]+\]\s+›\s+)?[^›\n]*›\s+(?:[^›\n]*›\s+)?(.+?)\s*(?:\(\d[^)]*\))?$/gm,
      ),
    ];
    const passed = lines.filter((line) => line[1] === '✓').length;
    const failed = lines.filter((line) => line[1] === '✘').length;
    const skipped = lines.filter((line) => line[1] === '-').length;
    const done = passed + failed + skipped;
    const last = lines.at(-1)?.[2]?.trim();
    const parts = [`${done} von ${total} Tests`, `${passed} ✓`];
    if (failed) parts.push(`${failed} ✗`);
    if (skipped) parts.push(`${skipped} übersprungen`);
    if (last && done < total) parts.push(`zuletzt: ${last.slice(0, 80)}`);
    return { text: parts.join(' · '), done, total, failed };
  }
  // TAP (node --test): „ok 12 - Titel“ bzw. „not ok 13 - Titel“; die Gesamtzahl steht erst am Ende („# tests 800“).
  const ok = text.match(/^ok \d+ - /gm)?.length ?? 0;
  const notOk = text.match(/^not ok \d+ - /gm)?.length ?? 0;
  if (ok + notOk) {
    const total = Number(/^# tests (\d+)$/m.exec(text)?.[1] ?? 0) || null;
    const parts = [total ? `${ok + notOk} von ${total} Tests` : `${ok + notOk} Tests`, `${ok} ✓`];
    if (notOk) parts.push(`${notOk} ✗`);
    return { text: parts.join(' · '), done: ok + notOk, total, failed: notOk };
  }
  if (/Application bundle generation complete/i.test(text)) {
    return { text: 'Oberfläche gebaut, Tests starten …', done: 0, total: null, failed: 0 };
  }
  if (/ng build|Building|Initial chunk files/i.test(text)) {
    return { text: 'Oberfläche wird gebaut …', done: 0, total: null, failed: 0 };
  }
  return { text: 'läuft …', done: 0, total: null, failed: 0 };
}
