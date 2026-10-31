// Routine-Vorlagen (zeitgesteuerte Agent-Aufgaben), die jedes Projekt einmal deaktiviert bekommt (default-actions.ts).

/** Vorlage für eine zeitgesteuerte Routine (Agent-Aufgabe mit Zeitplan, Europe/Zurich). */
export interface RoutineTemplate {
  id: string;
  title: string;
  prompt: string;
  /** Cron mit 5 Feldern. */
  schedule: string;
  outputTarget: 'chat' | 'push' | 'bug' | 'idea' | 'order';
  /** Optionales Zeitfenster „HH:MM-HH:MM“. */
  runWindow?: string;
}

const READ_ONLY = 'Nur lesen: ändere keine Dateien, installiere nichts und committe nichts.';

/**
 * Routine-Vorlagen: kommen bei jedem Projekt einmal in die Agent-Aufgaben – immer deaktiviert, bis jemand sie
 * einschaltet. Alle sind nur lesend; Befunde gehen über die Marker (@@BUG, @@IDEA, @@ORDER) weiter.
 */
export const ROUTINE_TEMPLATES: RoutineTemplate[] = [
  {
    id: 'security-nightly',
    title: 'Nächtlicher Sicherheits-Check',
    prompt: `${READ_ONLY} Führe \`npm audit\` und \`npm outdated\` aus. Melde jede Sicherheitslücke ab Schwere „moderate“ als eigenen Bug (Paket, betroffene Version, behobene Version, Schwere) und fasse veraltete Hauptversionen kurz zusammen.`,
    schedule: '0 2 * * *',
    outputTarget: 'bug',
    runWindow: '22:00-06:00',
  },
  {
    id: 'docs-weekly',
    title: 'Wöchentlicher Doku-Abgleich',
    prompt: `${READ_ONLY} Vergleiche README und docs/ mit dem aktuellen Code: Befehle, Skripte, Umgebungsvariablen, Endpunkte und beschriebene Abläufe. Melde jede veraltete oder fehlende Stelle als Auftrag mit Datei und konkretem Änderungsvorschlag.`,
    schedule: '0 3 * * 1',
    outputTarget: 'order',
  },
  {
    id: 'dead-files-todos',
    title: 'Tote Dateien und TODOs finden',
    prompt: `${READ_ONLY} Suche Dateien, die nirgends importiert oder referenziert werden, sowie TODO-, FIXME- und HACK-Kommentare (z. B. mit \`git ls-files\` und \`git grep -n TODO\`). Melde zusammengehörige Funde als Idee mit Fundstellen; nichts löschen.`,
    schedule: '0 4 * * 0',
    outputTarget: 'idea',
  },
  {
    id: 'coverage-75',
    title: 'Testabdeckung unter 75 % melden',
    prompt: `${READ_ONLY} Ermittle die Testabdeckung je Bereich aus dem letzten Abdeckungsbericht des Projekts (z. B. coverage/coverage-summary.json oder lcov.info) oder mit dem Abdeckungsskript des Projekts, falls es erlaubt ist. Melde jeden Bereich unter 75 % als Auftrag. Fehlt ein Messwert oder ist der Befehl blockiert, gilt das nicht als bestanden: melde den fehlenden Wert ausdrücklich als Hinweis, nicht als 0 % oder leer.`,
    schedule: '0 5 * * 1',
    outputTarget: 'order',
  },
];
