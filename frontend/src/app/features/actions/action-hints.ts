/**
 * Hover-Texte der Knöpfe auf der Seite „Aktionen“: was der Klick bewirkt. Besonders „Erneut versuchen“ und
 * „Neu analysieren“ werden leicht verwechselt – das eine startet die Agents, das andere nur die Problemanalyse.
 */
export const ACTION_HINTS: Record<string, string> = {
  'Erneut versuchen':
    'Startet den Auftrag noch einmal mit den Agents (Entwickler, Tester …). Deine Ergänzung geht als Hinweis mit. ' +
    'Ändert Code – anders als „Neu analysieren“.',
  'Angepasst – erneut versuchen':
    'Du hast die Regel bzw. Einstellung angepasst: Die Agents starten den Auftrag noch einmal.',
  'So umsetzen lassen': 'Die Agents setzen den Lösungsvorschlag der Analyse um; deine Ergänzung geht zusätzlich mit.',
  'Wieder einplanen': 'Der Auftrag kommt zurück in die Planung und wird mit dem nächsten Sprint wieder bearbeitet.',
  'Geprüft – alles in Ordnung': 'Vermerkt alle Punkte, die nur ein Mensch prüfen kann, auf einmal als von dir geprüft.',
  '🤖 Prüfen': 'Der Tester-Agent prüft nur diesen Punkt noch einmal und hakt ihn ab, wenn er erfüllt ist.',
  '🤖 Alle automatisch prüfen':
    'Der Tester-Agent prüft alle offenen Punkte noch einmal; erfüllte hakt er ab, der Rest bleibt offen.',
  'Neu analysieren':
    'Der Assistent untersucht nur, warum der Auftrag hängt, und schlägt eine Lösung vor. Es wird kein Code ' +
    'geändert – umsetzen lässt du den Vorschlag danach selbst.',
  '✓ Freigeben': 'Gibt das Ergebnis frei: Der Worker übernimmt den Auftrags-Branch in den Sprint.',
  '↩ Zurückweisen': 'Schickt den Auftrag mit deiner Begründung zurück an die Agents.',
};

export function actionHint(label: string): string {
  return ACTION_HINTS[label] ?? '';
}
