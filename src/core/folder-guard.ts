import { existsSync, statSync } from 'node:fs';

/**
 * Erreichbarkeit der Projektordner. Liegen sie auf einem externen Laufwerk (/Volumes/…), kann es kurz wegfallen
 * (Kabel, Hub, Stromversorgung). Ein Agent, der in dieser Zeit scheitert, hat keinen Fehler im Auftrag gefunden – der
 * Lauf gilt als unterbrochen und wird erneut eingeplant, statt den Auftrag zu blockieren und Bugs anzulegen.
 */
interface Outage {
  since: number;
  until: number | null;
}

const outages = new Map<string, Outage[]>();
const KEEP_MS = 24 * 3600_000;

export function folderAvailable(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Einhängepunkt eines externen Laufwerks („/Volumes/External“), sonst null. */
export function volumeOf(path: string): string | null {
  return /^\/Volumes\/[^/]+/.exec(path)?.[0] ?? null;
}

/** Meldung für einen fehlenden Ordner: bei externen Laufwerken mit dem wahrscheinlichen Grund. */
export function missingFolderMessage(path: string): string {
  const volume = volumeOf(path);
  return volume
    ? `Laufwerk „${volume.slice('/Volumes/'.length)}“ ist nicht verbunden – ${path} ist nicht erreichbar. Agents und Assistent warten, bis es wieder da ist.`
    : `Ordner nicht erreichbar: ${path}`;
}

/**
 * Hält fest, welche Ordner gerade fehlen; liefert die Ordner, deren Ausfall eben begonnen bzw. geendet hat
 * (für Meldungen). `now` nur für Tests.
 */
export function noteFolders(
  paths: readonly string[],
  now = Date.now(),
  available: (path: string) => boolean = folderAvailable,
): { lost: string[]; back: string[] } {
  const lost: string[] = [];
  const back: string[] = [];
  for (const path of new Set(paths)) {
    const list = outages.get(path) ?? [];
    const open = list.at(-1)?.until === null ? list.at(-1) : undefined;
    if (!available(path)) {
      if (!open) {
        list.push({ since: now, until: null });
        lost.push(path);
      }
    } else if (open) {
      open.until = now;
      back.push(path);
    }
    outages.set(
      path,
      list.filter((entry) => entry.until === null || now - entry.until < KEEP_MS),
    );
  }
  return { lost, back };
}

/** War der Ordner seit `since` (ms) zeitweise oder ist er jetzt nicht erreichbar? */
export function hadOutage(
  path: string,
  since: number,
  now = Date.now(),
  available: (path: string) => boolean = folderAvailable,
): boolean {
  if (!available(path)) return true;
  return (outages.get(path) ?? []).some((entry) => entry.since <= now && (entry.until ?? now) >= since);
}

/** Prüft die Ordner regelmässig; `onChange` meldet Ausfälle und Rückkehr. Liefert eine Stopp-Funktion. */
export function watchFolders(
  paths: () => readonly string[],
  onChange: (change: { lost: string[]; back: string[] }) => void,
  intervalMs = 2_000,
): () => void {
  const timer = setInterval(() => {
    const change = noteFolders(paths());
    if (change.lost.length || change.back.length) onChange(change);
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** Nur für Tests: gemerkte Ausfälle löschen. */
export function resetOutages(): void {
  outages.clear();
}
