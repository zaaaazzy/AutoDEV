# Globale Styles nach Bereich statt nach Entstehungszeit

Umbau vom 23.10.2026, Branch `refactor/styles-nach-bereich`. Umsetzung der Punkte 1 und 2 aus „Offen“ in
[frontend-struktur-html-css-2026-10-22.md](frontend-struktur-html-css-2026-10-22.md).

## Ergebnis

- **17 statt 27 Dateien**, benannt nach Bereich. Die Ladereihenfolge in `angular.json` geht vom Allgemeinen zum
  Besonderen:

  | Datei | Inhalt | aus den alten Dateien |
  | --- | --- | --- |
  | `01-base.css` | Farb-Tokens, Grundelemente (Text, Felder, Dropdowns), Hilfsklassen | 01, 02, 12, 25 |
  | `02-layout.css` | Seitenleiste, Kopfzeile Desktop und Handy, Projektwahl, Stand-Auswahl, Agent-Popover, Live-Dekoration | 02, 04, 06, 08, 09, 11, 12, 26 |
  | `03-buttons-forms.css` | Knöpfe, Formulare, Schalter, Häkchen, Ordnerauswahl | 02, 03, 04, 05, 07, 08, 12, 18, 20 |
  | `04-components.css` | Panels, Karten, Kennzahlen, Status, Tags, Hinweise, Markdown, Anteilsbalken, aufklappbare Panels, Detailansichten | 02, 03, 04, 08, 11, 12, 14, 15, 16, 18, 19, 20, 23, 27 |
  | `05-tables.css` | Datentabellen inkl. Handy-Kartenansicht, Listen mit Aufklappzeilen | 02, 03, 04, 06, 08, 12, 15, 23 |
  | `06-dialogs.css` | Modal, Hilfe, Bestätigung, geführte Einrichtung, Tour, Begrüßung | 02, 07, 10, 16 |
  | `07-setup-wizard.css` | Projekt-Assistent | 05 |
  | `08-orders.css` | Auftrag: Detail, Verlauf, Agent-Ausgaben, Abnahme, optische Abnahme | 03, 05, 06, 08, 12, 13, 14, 16, 18, 20, 21, 23 |
  | `09-dashboard.css` | Dashboard, Aktionen, Statistik | 04, 08, 11, 16, 18, 19, 21, 23 |
  | `10-ideas.css` | Ideen-Dialog, Kommentare, Visionär | 02, 03, 15, 16, 23 |
  | `11-chat.css` | Assistenten-Chat, Eingabe, Agent-Aufgaben, Vergrößern | 02, 03, 04, 11, 12, 13, 16, 25 |
  | `12-sprints.css` | Sprint-Detail, Planung, Review-Container, CI-Ampel | 03, 08, 10, 13, 18, 22 |
  | `13-docs.css` | Dokumentation | 02, 09, 23, 24 |
  | `14-agents.css` | Workflow, Rechte, Aktionen, Rollen | 02, 03, 14, 17 |
  | `15-tests.css` | Testläufe | 14, 15 |
  | `16-bugs.css` | Bugs, Bug-Statistik, Produktions-Rückkanal | 08, 18, 19 |
  | `17-settings.css` | Einstellungen, Login, Benutzer und Rollen, Budget, GitHub | 05, 07, 10, 14, 18, 19, 21, 22, 27 |

  `orders` lädt vor `dashboard`: Die Seite „Aktionen“ zeigt Auftrags-Bausteine und passt sie an, das muss danach kommen.
- **Kein Selektor steht mehr in zwei Dateien** (je Medienkontext). Vorher waren es 27 ohne `@media`-Unterschied, mit
  den Handy-Varianten 46. 36 Überschreibungen sind in ihre Grundregel gezogen, darunter `.topbar` und `.sidebar`/
  `.menu-toggle` am Handy (02 + 08), `.order-panel` (03 + 23), `.timeline`, `.step-output` und `.live-progress`
  (03 + 08), `.idea-table tr.row-open > td` (zweimal 03), `:root` (01 + 25), `input, select, textarea` (01 + 12).
  Die Handy-Varianten (`.topbar` in 08/09, `.order-panel` in 06) liegen jetzt im `@media`-Block derselben Datei.
- **Pro Bereich zuerst die Grundregeln, dann die `@media`-Blöcke**, nach Breite sortiert (47 statt 61 Blöcke). Eine
  `@media`-Regel bleibt nur dort an ihrer alten Stelle, wo sie sonst eine spätere Überschreibung überspringen würde.
- **Hilfsklassen** in `01-base.css`, im HTML an 55 Stellen eingesetzt (30 Templates); die gleichen Zeilen fallen in 41
  Bereichsregeln weg:
  - `.plain-list` (Liste ohne Punkte und Einzug): 11 Listen, z. B. `.risk-list`, `.running-list`, `.routing-rules`,
    `.acceptance-list`, `.visual-steps`.
  - `.truncate` (einzeilig mit „…“): 7 Stellen, z. B. `.worker-status`, `.git-subject`, `.git-ref`, `.switcher-name`.
  - `.row` (Flex-Reihe, zentriert, 8 px Abstand): 23 Kopfzeilen, z. B. `.detail-heading`, `.docs-toolbar`,
    `.production-event-head`, `.chat-reply-to`.
  - Nicht umgestellt, weil eine Regel dazwischen sonst anders gewinnen könnte: `.changed-files`, `.wizard-steps`,
    `.permission-list`, `.guide-steps`, `.file-list`, `.step-issues`, `.share-label`, `.meta`, `.dt-toolbar`,
    `.dt-option`, `.agent-task`.
- **Styles-Bundle 179.52 kB** statt 182.03 kB (Budget-Warnung bei 185 kB), 12 387 statt 12 778 Zeilen.

## Wie die gleiche Darstellung belegt ist

Umsortieren ändert die Kaskade: Bei gleicher Spezifität gewinnt die später geladene Regel. Deshalb drei Prüfungen:

1. **Berechnete Styles aller Elemente** (`npm run check:styles`, neu: `e2e/styles-snapshot.check.ts`). Der Lauf
   meldet sich mit dem Beispielprojekt „Velowerk“ an und hält für jede Seite, jede aufgeklappte erste Tabellenzeile,
   alle geöffneten `<details>`, Ideen-Dialog, Projektwahl, Hilfe, Menü, Chat und Projekt-Assistent
   `getComputedStyle` jedes Elements samt `::before`/`::after` und einen ganzseitigen Screenshot fest. Das sind 62
   Zustände, Desktop (1280 px) und Handy (Pixel 7). `scripts/compare-style-snapshots.ts` vergleicht zwei Läufe.
   Abweichungen, die schon zwischen zwei Vorher-Läufen bestehen, gelten als Rauschen: Textbreiten und Budgetbalken
   hängen von den Zeitstempeln der Beispieldaten ab.
   - **Ergebnis: 62 von 62 Zuständen ohne Abweichung** in den berechneten Styles, keine Elemente fehlen oder kommen
     hinzu. Die neuen Hilfsklassen werden beim Zuordnen der Elemente ignoriert (`STYLE_IGNORE_CLASSES`).
   - Die verbleibenden Pixelunterschiede liegen im Rauschen der Vorher-Läufe (z. B. Dashboard 2207 gegenüber 2307 Pixel).
2. **Statische Prüfung** jedes Regelpaars, dessen Reihenfolge sich umdreht. Gemeldet wird ein Paar, wenn es
   dieselbe Eigenschaft mit anderem Wert, gleiche Spezifität und verträgliche Medienabfragen hat. Es muss außerdem
   laut HTML auf dasselbe Element passen können. Dafür zählt, welche Klassen gemeinsam an einem Element stehen,
   was per `[class]`/Präfix zusammengesetzt wird und welche Klassen nirgends vorkommen.
   - Die Prüfung hat die zwei echten Kaskaden-Fehler der ersten Fassungen gefunden: `.small` gegen `.muted` und die
     Hover-Farbe der Handy-Tabellen.
   - Übrig bleiben 183 theoretische Paare. Davon trifft im DOM der 62 Zustände nur eines tatsächlich dasselbe
     Element, und zwar ohne Abweichung: `.button` ⇄ `.small` an `button.button.small`. Dort entscheidet ohnehin das
     spezifischere `.button.small`. Die übrigen sind Selektoren wie `.x > :first-child` oder `.y p`, die im HTML
     nicht zusammentreffen.
3. **Zusammenführen** einer Überschreibung in die Grundregel bzw. Ersetzen eines Blocks durch eine Hilfsklasse nur,
   wenn keine Regel zwischen den beiden Positionen dieselbe Eigenschaft für dasselbe Element setzt.

Vorher | Nachher, jeweils der erste Bildschirm (vollständige Aufnahmen erzeugt `npm run check:styles`):

| Bereich | Desktop | Handy |
| --- | --- | --- |
| Login | ![](styles-nach-bereich-2026-10-23/login-desktop.png) | ![](styles-nach-bereich-2026-10-23/login-handy.png) |
| Dashboard | ![](styles-nach-bereich-2026-10-23/dashboard-desktop.png) | ![](styles-nach-bereich-2026-10-23/dashboard-handy.png) |
| Aktionen | ![](styles-nach-bereich-2026-10-23/aktionen-desktop.png) | ![](styles-nach-bereich-2026-10-23/aktionen-handy.png) |
| Dokumentation | ![](styles-nach-bereich-2026-10-23/doku-desktop.png) | ![](styles-nach-bereich-2026-10-23/doku-handy.png) |
| Ideen | ![](styles-nach-bereich-2026-10-23/ideen-desktop.png) | ![](styles-nach-bereich-2026-10-23/ideen-handy.png) |
| Idee (Dialog) | ![](styles-nach-bereich-2026-10-23/idee-dialog-desktop.png) | ![](styles-nach-bereich-2026-10-23/idee-dialog-handy.png) |
| Aufträge | ![](styles-nach-bereich-2026-10-23/auftraege-desktop.png) | ![](styles-nach-bereich-2026-10-23/auftraege-handy.png) |
| Sprints | ![](styles-nach-bereich-2026-10-23/sprints-desktop.png) | ![](styles-nach-bereich-2026-10-23/sprints-handy.png) |
| Bugs | ![](styles-nach-bereich-2026-10-23/bugs-desktop.png) | ![](styles-nach-bereich-2026-10-23/bugs-handy.png) |
| Testläufe | ![](styles-nach-bereich-2026-10-23/testlaeufe-desktop.png) | ![](styles-nach-bereich-2026-10-23/testlaeufe-handy.png) |
| Agents | ![](styles-nach-bereich-2026-10-23/agents-desktop.png) | ![](styles-nach-bereich-2026-10-23/agents-handy.png) |
| Statistik | ![](styles-nach-bereich-2026-10-23/statistik-desktop.png) | ![](styles-nach-bereich-2026-10-23/statistik-handy.png) |
| Einstellungen | ![](styles-nach-bereich-2026-10-23/einstellungen-desktop.png) | ![](styles-nach-bereich-2026-10-23/einstellungen-handy.png) |
| Chat | ![](styles-nach-bereich-2026-10-23/chat-desktop.png) | ![](styles-nach-bereich-2026-10-23/chat-handy.png) |
| Projekt-Assistent | ![](styles-nach-bereich-2026-10-23/projekt-assistent-desktop.png) | – (am Handy ohne Projektwahl-Menü) |

## Grenzen

- Belegt sind die 62 Zustände. Nicht aufgenommen sind u. a. Hover- und Fokus-Zustände, Fehlermeldungen in
  Formularen, Bestätigungsdialoge, Tour und Begrüßung, die Stand-Auswahl in der Kopfzeile (im Beispielprojekt nicht
  sichtbar) sowie Projektwahl und Assistent am Handy. Für diese gilt nur die statische Prüfung.
- Ganzseitige Handy-Screenshots über ~60 000 px zeigen in Chrome Kachelfehler am Seitenrand (Statistik). Das betrifft
  die Aufnahme, nicht das CSS; die berechneten Styles sind dort gleich.

## Worauf zu achten ist

- **Neue Regeln in die Datei ihres Bereichs**, Anpassungen für Handy und Tablet in deren `@media`-Block am Dateiende.
  `styles-order.spec.ts` schlägt fehl, wenn derselbe Selektor (im selben Medienkontext) in einer zweiten Datei auftaucht.
- **Seiten passen Bausteine über einen eigenen, spezifischeren Selektor an** (z. B. `.attention-table .attention-section p`), nicht durch
  dieselbe Klasse in einer späteren Datei.
- **Für wiederkehrende Muster die Hilfsklassen nutzen** (`plain-list`, `truncate`, `row`) statt die drei Zeilen erneut
  zu schreiben.
- **Vor einem größeren CSS-Umbau** `npm run check:styles` auf main und auf dem Branch laufen lassen und vergleichen:

  ```bash
  STYLE_SNAPSHOT_DIR=/tmp/vorher npm run check:styles   # auf main
  STYLE_SNAPSHOT_DIR=/tmp/nachher npm run check:styles  # auf dem Branch
  npx tsx scripts/compare-style-snapshots.ts /tmp/vorher /tmp/nachher
  ```

## Offen

- ~~**Ungenutzte Regeln.**~~ Am 24.10. entfernt: 179 Selektoren (162 ganze Regeln, ~840 Zeilen), deren Klassen in
  keinem Template und keinem Code vorkommen, z. B. `.item-card`, `.sprint-task`, `.workflow-board`, `.attention-card`.
  `npm run check:styles` zeigt in allen 62 Zuständen keine Abweichung.
- Punkte 3–5 aus dem Bericht vom 22.10. (Skalen für Radius, Schrift und Breakpoints, restliche Farbtöne, leere
  Zustände) bleiben offen. `npm run check:styles` macht die dabei gewollten kleinen Änderungen sichtbar.
