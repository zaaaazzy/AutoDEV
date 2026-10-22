# Frontend: Aufbau, Redundanz, HTML/CSS vereinheitlichen

Code-Review des Angular-Frontends (`frontend/src`) vom 22.10.2026. Stand: Branch `refactor/html-css-vereinheitlichen`.

## Aufbau heute

- **Komponenten:** `app/core` (Dienste, Store), `app/features/<bereich>` (Seiten), `app/shared` (wiederverwendbare Bausteine, Pipes). Die Aufteilung ist sauber; Features importieren aus `shared`, nicht untereinander.
- **Styles:** keine Komponenten-Styles. Alles liegt global in 27 Dateien `frontend/src/styles/NN-*.css` (~12 800 Zeilen, Bundle ~182 kB, Budget-Warnung bei 185 kB).
- Die Dateien sind **nach Entstehungszeit** benannt, nicht nach Bereich (`11-dashboard-git-assistant`, `13-acceptance-chat-planning`, `18-folders-bugs-sprint`). Neue Arbeit wurde jeweils hinten angehängt.

## Befunde

### Umgesetzt in diesem Branch

1. **Dialoge doppelt gebaut.** Sechs Dialoge (Hilfe, Idee, Projekt-Assistent, Einrichtungs-Anleitung, Bestätigung, Willkommen) hatten je eigenes Gerüst aus `.modal-backdrop`, `role="dialog"`, `aria-modal`, Klick daneben und `stopPropagation`. Escape war uneinheitlich: Hilfe hörte auf dem Hintergrund (griff nur mit Fokus darin), Anleitung gar nicht, Idee am Dokument.
   - Neu: `shared/modal.component.ts` (`<app-modal panelClass="…" labelledBy="…" (closed)="…">`). Klassen und DOM bleiben gleich (`.modal-backdrop > section[role=dialog]`), das CSS ist unverändert.
   - Escape schliesst nur den **obersten** offenen Dialog (Bestätigung über einer Idee schliesst nicht beide).
   - `dismissable=false` beim Willkommen (wie bisher kein Schliessen per Klick daneben). `closeOnEscape=false` beim Assistenten (Eingaben gingen sonst verloren) und bei der Idee (eigene Logik: Escape beendet zuerst die Bearbeitung).
   - Verhalten neu: Hilfe und Einrichtungs-Anleitung schliessen jetzt zuverlässig mit Escape.
   - Der Chat-Hintergrund (`chat-zoom-backdrop`) ist nur eine Abdeckung ohne Dialog und bleibt eigenständig.
2. **Hartkodierte Farben.** ~290 Farbwerte standen direkt im CSS statt als Token. Neu in `01-base.css`: `--surface`, `--surface-soft`, `--line-strong`, `--green-light`, `--green-soft`, `--warn`, `--warn-soft`, `--danger`, `--blue`. Ersetzt wurden nur exakt gleiche Werte (`#fff`/`white`, `#fafbf8`, `#f4f5f1` → `--paper` usw.); die Darstellung ändert sich nicht.
   - Einzige Angleichung: `#6b756f` (19×) → `--muted` (`#6d766f`), Unterschied nicht sichtbar.
3. `agent-detail`: Lade-Hinweis mit `role="status"` wie die übrigen fünf.

### Offen (Empfehlung)

1. **CSS nach Bereich statt nach Datum ordnen.** 58 Selektoren werden in mehreren Dateien definiert und überschrieben, z. B. `.topbar` (02, 08, 09), `.order-panel` (03, 06, 23), `.sidebar`/`.menu-toggle` (02, 08), `.timeline`/`.step-output` (03, 08), `.idea-table tr.row-open` (03, 06). Wer eine Regel ändert, muss alle Stellen und die Ladereihenfolge kennen.
   - Vorschlag: pro Bereich eine Datei (`layout`, `buttons-forms`, `tables`, `dialogs`, `dashboard`, `orders`, `ideas`, `chat`, `sprints`, `settings`, …) und die Überschreibungen dabei in die Grundregel ziehen. Das verschiebt die Kaskade und braucht pro Bereich einen Vorher/Nachher-Vergleich (Screenshots aus `e2e/full-ui.check.ts`). Eigener Auftrag.
2. **Wiederholte Muster ohne gemeinsame Klasse.** Identische Deklarationsblöcke unter verschiedenen Namen, z. B.
   - Liste ohne Aufzählungszeichen als Raster (`display:grid; list-style:none; margin:0; padding:0` mit gap 4/6/8): `.permission-list`, `.review-slot-list`, `.running-list`, `.routing-rules`, `.risk-list`, `.changed-files`, `.file-list`, `.agent-action-list`, `.draft-list`, `.user-list` u. a.
   - Text abschneiden (`overflow:hidden; text-overflow:ellipsis; white-space:nowrap`): 10 Stellen.
   - Kopfzeile als Flex-Reihe (`align-items:center; display:flex; gap:8px` ± `flex-wrap`/`space-between`): ~12 Stellen.
   - Vorschlag: Hilfsklassen `.plain-list`, `.truncate`, `.row` einführen und beim Umbau nach Bereich (Punkt 1) im HTML einsetzen.
3. **Viele Einzelwerte.** 20 verschiedene `border-radius` (2–24 px, dazu 999 px), 15 Schriftgrössen (10–24 px, auch 12.5/13.5 px), 15 verschiedene Breakpoints (480–1600 px, 27× 720 px). Vorschlag: Skala als Token (`--radius-s/m/l`, `--text-xs/s/m`) und zwei, drei Breakpoints.
4. **Restliche Farben.** Weitere ~80 Farbtöne kommen 2–10× vor (Orange-, Rot-, Grüntöne für Zustände). Beim Umbau nach Bereich zu den Zustands-Tokens zusammenführen; das ändert die Darstellung leicht und braucht Abnahme.
5. **Leere Zustände.** 13× `<p class="empty-state">Keine …`, 25× `<p class="muted">Keine …`. Das ist überwiegend gewollt (ganzer Bereich leer vs. leere Teil-Liste); Sonderklassen `thread-empty`, `workflow-empty`, `agent-tasks-empty` sind kontextbezogen und bleiben.

## Worauf zu achten ist

- **Neue Dialoge** mit `<app-modal>` bauen, nicht mit eigenem `.modal-backdrop`.
- **Neue Farben** als Token in `01-base.css` anlegen, nicht als Hex-Wert im Bereichs-CSS.
- Das Style-Budget liegt bei ~182 von 185 kB (Warnung). Die Tokens kosten ~3 kB, weil `var(--surface)` länger ist als `#fff`. Beim Umbau nach Bereich sollte das Bundle wieder kleiner werden (Überschreibungen fallen weg).
