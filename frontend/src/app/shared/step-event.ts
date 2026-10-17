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
    if (match) return { kind, label, target: match[1]!.replace(/^„|“$/g, ''), text: '', file: FILE_LABELS.has(label) };
  }
  return { kind: STATE.test(text) ? 'state' : 'note', label: '', target: '', text, file: false };
}
