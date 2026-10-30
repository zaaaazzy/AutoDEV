import { defined } from '../../../../src/core/defined.js';

export type StepEventKind = 'read' | 'write' | 'run' | 'note' | 'state';

export interface StepEventView {
  kind: StepEventKind;
  label: string;
  /** Datei, Suchmuster oder Befehl – hervorgehoben als Code. */
  target: string;
  /** Freitext ohne Ziel, z. B. ein Zwischenstand des Agents. */
  text: string;
  /** Das Ziel ist ein Dateipfad (Lesen/Schreiben einer Datei) und kann verlinkt werden. */
  file: boolean;
  /** Symbol statt Text-Etikett. */
  icon: 'read' | 'search' | 'write' | 'run' | null;
}

export interface FileActivity {
  target: string;
  file: boolean;
  /** Zeitpunkt der letzten Aktion. */
  at: string;
  count: number;
}

/** Fasst den Verlauf nach Dateien zusammen: geschrieben, gelesen, ausgeführt (jeweils neueste zuerst). */
export function summarizeFiles(events: { at: string; text: string }[]): {
  written: FileActivity[];
  read: FileActivity[];
  run: FileActivity[];
} {
  const groups = {
    written: new Map<string, FileActivity>(),
    read: new Map<string, FileActivity>(),
    run: new Map<string, FileActivity>(),
  };
  for (const event of events) {
    const view = describeStepEvent(event.text);
    const group =
      view.kind === 'write'
        ? groups.written
        : view.kind === 'run'
          ? groups.run
          : view.icon === 'read'
            ? groups.read
            : null;
    if (!group || !view.target) continue;
    const entry = group.get(view.target);
    group.set(view.target, { target: view.target, file: view.file, at: event.at, count: (entry?.count ?? 0) + 1 });
  }
  const sorted = (map: Map<string, FileActivity>) => [...map.values()].sort((a, b) => b.at.localeCompare(a.at));
  return { written: sorted(groups.written), read: sorted(groups.read), run: sorted(groups.run) };
}

const FILE_LABELS = new Set(['Liest', 'Bearbeitet', 'Schreibt']);
const PATTERNS: [RegExp, StepEventKind, string][] = [
  [/^Liest (.+)$/, 'read', 'Liest'],
  [/^Sucht nach (.+)$/, 'read', 'Sucht'],
  [/^Sucht Dateien (.+)$/, 'read', 'Sucht'],
  [/^Bearbeitet (.+)$/, 'write', 'Bearbeitet'],
  [/^Schreibt (.+)$/, 'write', 'Schreibt'],
  [/^Führt aus: (.+)$/s, 'run', 'Führt aus'],
];
const STATE = /^(Schritt gestartet|Erfolgreich abgeschlossen|Fehlgeschlagen|Abgebrochen)/;

/** Ordnet einen Verlaufseintrag ein: Lesen, Schreiben, Ausführen, Zwischenstand oder Schrittstatus. */
export function describeStepEvent(text: string): StepEventView {
  for (const [pattern, kind, label] of PATTERNS) {
    const match = pattern.exec(text);
    if (match) {
      const icon = label === 'Sucht' ? 'search' : kind === 'read' ? 'read' : kind === 'write' ? 'write' : 'run';
      return {
        kind,
        label,
        target: defined(match[1]).replace(/^„|“$/g, ''),
        text: '',
        file: FILE_LABELS.has(label),
        icon,
      };
    }
  }
  return { kind: STATE.test(text) ? 'state' : 'note', label: '', target: '', text, file: false, icon: null };
}
