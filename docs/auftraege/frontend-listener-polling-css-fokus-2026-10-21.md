# Frontend: Listener-Leck, Polling in verborgenen Tabs, CSS, Fokus

Auftrag 838b0cb4 (Bugfix) aus dem Code-Review vom 20.10.2026. Stand: 21.10.2026. Der Auftrag betrifft nur das Frontend.

## Was umgesetzt wurde

### 1. `beforeinstallprompt`-Listener (`core/install-prompt.ts`)
- Vorher hängte `notification-settings.component.ts` bei jedem Öffnen der Einstellungen einen neuen Listener an und entfernte ihn nie.
- Jetzt hängt `listenForInstallPrompt()` die Listener (`beforeinstallprompt`, `appinstalled`) **genau einmal beim Start** an. Mehrfache Aufrufe liefern dieselbe Aufräumfunktion.
- Der Zustand liegt im Signal `installPrompt`. Die Einstellungen lesen es nur noch.
- Das Ereignis kommt kurz nach dem Laden der Seite. Der Listener muss deshalb beim Start hängen, nicht erst in den Einstellungen.

### 2. Polling nur bei sichtbarem Tab (`core/visible-interval.ts`)
- Neuer Helfer `visibleInterval(tick, ms)`. Er verhält sich wie `setInterval`, pausiert aber bei `document.hidden`.
- Wird der Tab wieder sichtbar, läuft `tick` sofort einmal, danach wieder im Takt.
- Der Rückgabewert entfernt Timer und `visibilitychange`-Listener.
- Umgestellt: `ProjectStore` (Worker alle 10 s, Live-Läufe alle 3 s), `agent-activity.service.ts`, `review-launch.service.ts`, `review-state.service.ts`, `layout-check.ts` und weitere Komponenten mit Timern (`agent-tasks`, `chat`, `git-graph-panel`, `order-detail`, `comment-thread`, `ideation`, `sprint-review`, `order-timeline`, `runs`).

### 3. CSS-Nummerierung und Budget
- Die doppelte Nummer 20 ist aufgelöst: `20-visual.css` bleibt, danach `21-budget`, `22-github`, `23-actions-details`, `24-marketing`, `25-chat-zoom`.
- Die Reihenfolge in `angular.json` ist unverändert, nur die Dateinamen sind neu. Die Kaskade ändert sich nicht.
- Das Budget `anyComponentStyle` (12/20 kB) lief ins Leere, weil die Komponenten keine eigenen Styles haben. Es ist ersetzt durch ein Budget `bundle` mit dem Namen `styles` (Warnung 175 kB, Fehler 200 kB). Es greift auf das globale CSS.
- `styles-order.spec.ts` prüft: Nummern sind eindeutig und lückenlos, `angular.json` listet sie in derselben Reihenfolge, das Budget zielt auf das globale CSS.

### 4. Fokus und Tastaturbedienung
- `outline: none` ersetzt durch sichtbare Ringe in `05-setup-wizard.css`, `07-login-settings.css` und `09-docs-header.css`. Der Ring im Umschalter-Menü liegt innen (`outline-offset: -2px`), sonst schneidet das Menü ihn ab.
- Weitere `:focus-visible`-Stile in `11-dashboard-git-assistant.css`, `13-acceptance-chat-planning.css` und `15-ideas-comments.css`.
- `runs.component.html`: Die klickbaren `<li>` im Befunde-Bereich haben kein `(click)` mehr. Titel von Befunden und fehlgeschlagenen Schritten sind echte `<button class="link-button finding-open">`. `openFinding(event, …)` ist durch `openFailedStep(position)` ersetzt. Die Prüfung `closest('button, a, video')` entfällt.

## Geänderte Dateien (Kern)
- `angular.json`
- `frontend/src/app/core/`: `install-prompt.ts` (+ `.spec.ts`), `visible-interval.ts` (+ `.spec.ts`), `project-store.ts`, `agent-activity.service.ts`, `review-launch.service.ts`, `layout-check.ts`
- `frontend/src/app/features/runs/runs.component.{html,ts}`
- Weitere Komponenten mit umgestellten Timern (siehe oben)
- `frontend/src/styles/*.css` (Umbenennung und Fokus) und `styles-order.spec.ts`
- `e2e/app.spec.ts`: neue Tests „Befunde sind Buttons, per Tastatur und per Klick auf die Karte bedienbar“ und „Fokus-Ringe sind bei Tastaturbedienung sichtbar“

## Prüfung
- `npm run typecheck` grün.
- Unit-Tests `install-prompt.spec.ts`, `visible-interval.spec.ts`, `styles-order.spec.ts` grün (6 Tests bei der Reihenfolge).
- E2E `e2e/app.spec.ts`: 52 bestanden, 2 übersprungen.
- Der Tester meldet 803 Unit- und Integrationstests grün.

## Worauf zu achten ist
- **Neue Timer** im Frontend mit `visibleInterval` anlegen, nicht mit `setInterval`. Die Aufräumfunktion über `DestroyRef` aufrufen.
- **Neue CSS-Datei:** Nummer und Eintrag in `angular.json` zusammen ändern. `styles-order.spec.ts` schlägt sonst fehl.
- **Style-Budget:** Der Wert 175/200 kB gilt für alle globalen Styles. Der Build (`npm run build`) wurde im Tester-Lauf nicht gesondert dokumentiert. Bei Budgetfehlern zuerst den Build prüfen.
- **Offen:** Ob `@playwright/test` nur in einer Version installiert ist, konnte nicht geprüft werden (`npm ls` war gesperrt). Die E2E-Läufe liefen trotzdem durch.
- **Offen:** Es gab keine formalen Akzeptanzkriterien. Fokus-Stile in Dashboard, Ideen und Chat sind nur per Code-Lesen und teilweise per E2E belegt.
- Die Branch-Differenz zu `main` enthält viele weitere, nicht zu diesem Auftrag gehörende Änderungen (Backend, Sprint-Oberfläche). Sie sind hier nicht dokumentiert.
