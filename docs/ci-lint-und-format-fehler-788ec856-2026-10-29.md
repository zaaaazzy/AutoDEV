# CI rot: Lint- und Format-Fehler statt `test:unit`

Auftrag 788ec856 (Bugfix „CI CD nicht in Ordnung“), 29.10.2026.

## Problem

Gemeldet war, dass `npm run test:unit` in der CI fehlschlägt, vermutet wurde ein Folgefehler der Docker-Umstellung.

## Ursache

Nicht `test:unit`, sondern zwei andere Schritte des Jobs `check`:

- **`npm run lint`:** 2× `@typescript-eslint/no-explicit-any` in `scripts/angular-builder.test.ts`.
- **`npm run format:check`:** 6 nicht formatierte Dateien unter `frontend/src`.

Die Docker-Umstellung war nicht beteiligt.

## Umsetzung

- `scripts/angular-builder.test.ts`: die beiden `any` durch konkrete Typen ersetzt (keine Lint-Ausnahme, kein `eslint-disable`).
- Mit Prettier formatiert: `git-graph-state.spec.ts`, `git-graph.spec.ts`, `review-box.spec.ts`, `sprint-actions.spec.ts`, `sprint-actions.ts`, `acceptance-ticks.spec.ts`. Nur Formatierung, keine inhaltliche Änderung.

## Prüfung (laut Entwickler)

- `npm run test:unit`: 1833 von 1833 Tests bestanden (gleiche Zahl wie zuvor, kein Test entfernt oder übersprungen).
- `npm run lint`, `npm run format:check`, `npm run typecheck`: grün.
- Nicht belegt: ein echter Lauf in GitHub Actions. Die Dokumentation hat nichts davon erneut ausgeführt.
- Der Tester-Schritt konnte in der Sandbox nichts ausführen (`tsc: not found`, `EACCES`), siehe Nachtrag. Die Zahlen oben stammen deshalb nur vom Entwickler und sind vom Tester nicht bestätigt.

## Geänderte Dateien

- `deploy/agent/Dockerfile` (npm-Cache nach der Installation löschen, siehe Nachtrag)
- `docs/ci.md`, diese Datei
- `scripts/angular-builder.test.ts`
- `frontend/src/app/features/dashboard/git-graph-state.spec.ts`
- `frontend/src/app/features/dashboard/git-graph.spec.ts`
- `frontend/src/app/features/development/review-box.spec.ts`
- `frontend/src/app/features/sprints/sprint-actions.spec.ts`
- `frontend/src/app/features/sprints/sprint-actions.ts`
- `frontend/src/app/shared/acceptance-ticks.spec.ts`

## Worauf zu achten ist

- **Vor jedem Abschluss** auch `npm run lint` und `npm run format:check` ausführen, nicht nur `test:unit`. Alle drei gehören zum Job `check`.
- **Prettier prüft nur `src` und `frontend/src`**, nicht `scripts/`. Lint deckt `scripts/` ab.
- **Im nächsten echten CI-Lauf bestätigen**, dass `check` grün ist, erst dann den Bug schliessen.
- **Offen, nicht Teil dieses Auftrags:** `@angular-devkit/build-angular` steht noch im Lockfile. `npm ci` scheitert deswegen nicht. Das Aufräumen braucht ein manuelles `npm install` (für Agents gesperrt) und gehört zum Bug „Angular-Builder umstellen“.
- Meldungen mit „spend limit“ in anderen Bug-Einträgen sind keine Code-Fehler.

## Nachtrag: Tester-Schritt scheitert in der Docker-Sandbox

Der Tester konnte die Prüfungen nicht ausführen (`tsc: not found`, `npx` mit `EACCES`). Das ist kein Fehler im Code
und keiner der GitHub-CI. Es ist ein Folgefehler der Umstellung der Agents auf Container (`src/core/sandbox.ts`):

- **npm-Cache gehört root:** Im Image (`deploy/agent/Dockerfile`) läuft `npm install -g` als root mit
  `HOME=/home/agent`. Dadurch gehört `/home/agent/.npm` root, und der Agent ohne root (`--user`) kann nicht hineinschreiben.
  **Behoben:** Das Image löscht `/home/agent/.npm` nach der Installation. Wirksam erst nach einem Neubau des Images
  (`docker build -t aideation-agent -f deploy/agent/Dockerfile .` oder „AIdeation neu starten“).
- **`node_modules` fehlt im Container (offen):** `linkDependencies` (`src/runner/agent-workspace.ts`) legt im
  Worktree `node_modules` als absoluten Symlink auf den Host-Pfad des Hauptordners an (`/Volumes/…/source/node_modules`).
  Dieser Pfad existiert im Container nicht. Das Volume `aideation-node-modules-<projekt>` wird beim Einbinden auf dieses
  Ziel umgelenkt, und kein Schritt füllt es (`npm ci`). Deshalb fehlen `tsx`, `tsc`, `eslint` und `prettier`.
  `npm ci` im Container würde den Symlink im Host-Worktree ersetzen, darum hat der Agent es nicht ausgeführt.
  Nötig ist eine Entscheidung: entweder bei aktiver Sandbox im Worktree keinen Symlink anlegen und das Volume vor
  dem ersten Lauf einmal mit `npm ci --ignore-scripts` füllen, oder vorerst manuell den Symlink im Agent-Worktree
  entfernen und im Container `npm ci --ignore-scripts` ausführen.

## Nachtrag 30.10.2026: Volume wird vom Worker gefüllt

- **Umgesetzt (`src/core/sandbox.ts`):** `runInSandbox` füllt das Volume vor jedem Lauf, wenn der Worktree
  `package.json` und `package-lock.json` hat. Das erledigt ein eigener Container (`modulesInstallArgs`), nicht der Agent:
  - ohne root und ohne Capabilities, im Agent-Netzwerk, npm nur über den Egress-Proxy;
  - eingebunden sind nur das Volume unter `/deps/node_modules` sowie `package.json`, Lockfile und `.npmrc` (`:ro`),
    nicht der Worktree. Der Symlink im Worktree wird deshalb nicht angefasst;
  - `npm ci --ignore-scripts`, danach `npm rebuild esbuild` wie im Image.
- **Nur bei Bedarf:** Im Volume liegt `.aideation-lock` mit dem SHA-256 des Lockfiles. Stimmt er, entfällt `npm ci`. Ein
  neues Lockfile installiert also neu. Parallele Läufe desselben Projekts warten auf dieselbe Installation.
- **Fehlschlag:** Scheitert `npm ci`, startet der Lauf nicht. Die Meldung „Sandbox: npm ci im node_modules-Volume … ist
  fehlgeschlagen“ erscheint mit Ausgabe im Lauf und im Worker-Badge.
- **Lauf selbst:** Er bindet das Volume weiter unter `/workspace/node_modules` ein. Docker folgt dabei dem Symlink im
  Worktree, und dieser zeigt dann auf das gefüllte Volume.
- **Noch nicht belegt:** Agents dürfen in der Sandbox weder Tests noch Docker ausführen (`tsx: not found`, Wächter).
  Bisher liefen also weder die neuen Unit-Tests in `src/core/sandbox.test.ts` noch `npm run test:unit` noch ein Lauf
  gegen echtes Docker. Nötig sind deshalb: Worker mit dem neuen Code neu starten („AIdeation neu starten“, baut auch das
  Image `aideation-agent` neu), dann einen Lauf starten. Das Volume füllt sich dabei. Den Bug erst nach einem grünen
  GitHub-Actions-Lauf (Jobs `check` und `docker`) schliessen.
