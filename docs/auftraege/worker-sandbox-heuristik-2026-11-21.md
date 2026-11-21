# Worker: Sandbox-Heuristik, pnpm/Yarn, Pausen-Race

Branch `fix/worker-sandbox-heuristik`, 21.11.2026. Anlass: Projekt „pianotrainer“ am 21.11.2026.

## Beobachtung

Der Entwickler legte ein pnpm-Monorepo an (`pnpm-workspace.yaml`, Abhängigkeiten mit `workspace:*`). Vor dem Tester
installierte der Arbeitscontainer fest mit `npm install --ignore-scripts …`; npm scheiterte mit „Cannot read properties of
null (reading 'edgesOut')“. Die Meldung begann mit „Arbeitscontainer: Abhängigkeiten liessen sich nicht installieren“,
und `isSandboxFailure` (`src/runner/autofix.ts`) stuft jede Zeile `^(Sandbox|Arbeitscontainer): ` als Infrastruktur-Defekt
ein. Folge: Auftrag zurück auf „geplant“, Projekt 60 Minuten pausiert, nach zwei Pausen blockiert – ohne Bug-Bericht,
obwohl der Fehler im `package.json` des Projekts lag. Zusätzlich griff die Projekt-Pause nicht: `pauseOrder` schrieb
`retry_after` um 17:16:25 UTC, zwei Sekunden später startete der Worker den nächsten Auftrag desselben Projekts, weil
die Auswahl des Takts (`selectItems`) schon vor der Pause gelaufen war. Der baute dann ein zweites, npm-basiertes
Grundgerüst.

## Änderungen

### 1. Heuristik eingegrenzt (`src/core/sandbox-base.ts`, `src/core/workbench.ts`, `src/core/sandbox.ts`)

- Scheitert die Installation der Projekt-Abhängigkeiten, lautet die Meldung jetzt
  `Projekt-Abhängigkeiten: „<npm|pnpm|yarn> install“ im Arbeitscontainer scheiterte (Exit-Code N). Befehl nicht gestartet – Fehler im package.json, Lockfile oder Workspace des Projekts prüfen.`
  (`dependencyFailureMessage`, Präfix `PROJECT_INSTALL_PREFIX`), in beiden Modi (Arbeitscontainer und kurzlebige
  Sandbox). Sie trifft kein Sandbox-Muster mehr: `registerFailure` legt einen normalen Bug-Bericht an, das Projekt pausiert
  nicht.
- Die Muster in `isSandboxFailure` bleiben unverändert. Echte Infrastrukturfehler lösen weiter die Projekt-Pause aus:
  `Arbeitscontainer: node_modules-Volume … liess sich nicht vorbereiten`, `Sandbox: … Image/Container …`, root-eigener
  npm-Cache, nicht schreibbares Log-Verzeichnis, `Error response from daemon`. Steht ein solches Muster in der Ausgabe
  einer gescheiterten Installation, gilt sie weiterhin als Sandbox-Defekt.
- Das Worker-Badge (`noteProblem`) zeigt eine gescheiterte Projekt-Installation nicht mehr als Sandbox-Problem; der
  Container selbst läuft ja.

### 2. pnpm und Yarn (`src/core/sandbox-base.ts`, `deploy/agent/Dockerfile`)

- `packageManagerOf(worktree)`: `pnpm-lock.yaml` oder `pnpm-workspace.yaml` → pnpm; `yarn.lock` → Yarn (mit
  `.yarnrc.yml` Yarn ab 2, sonst 1.x); sonst npm. pnpm gewinnt vor Yarn, falls beide Lockfiles liegen.
- `dependencyCommand(stamp, manager)`:
  - pnpm: `corepack pnpm install --frozen-lockfile=false --ignore-scripts --store-dir node_modules/.cache/pnpm-store`
  - Yarn 1.x: `corepack yarn install --ignore-scripts --non-interactive --cache-folder node_modules/.cache/yarn`
  - Yarn ab 2: `corepack yarn install` mit `YARN_ENABLE_IMMUTABLE_INSTALLS=false`, `YARN_ENABLE_SCRIPTS=false`,
    `YARN_GLOBAL_FOLDER` im Volume und `YARN_HTTP(S)_PROXY` aus `HTTP(S)_PROXY` (Yarn ab 2 liest den Proxy nur aus
    seiner eigenen Konfiguration).
  - npm: unverändert.
  - Corepack läuft mit `COREPACK_HOME` im Volume, `COREPACK_NPM_REGISTRY=https://registry.npmjs.org`,
    `COREPACK_ENABLE_DOWNLOAD_PROMPT=0`, `COREPACK_DEFAULT_TO_LATEST=0`. Die Paketversion kommt aus dem Feld
    `packageManager` des Projekts, sonst aus Corepacks fester Standardversion.
- Stempel (`DEPENDENCY_STAMP`, `dependencyStamp`): Hash aus Paketmanager und Lockfile (sonst `package.json`, bei pnpm
  zusätzlich `pnpm-workspace.yaml`). Ein Wechsel des Paketmanagers bei gleichem Manifest installiert neu. Sperre (`flock`)
  und Aufräumen des Volumes bleiben wie bisher.
- Egress: Corepack lädt pnpm und Yarn (auch Yarn ab 2, dank `COREPACK_NPM_REGISTRY`) von `registry.npmjs.org`, das der
  Egress-Proxy schon freigibt; Corepack beachtet `HTTPS_PROXY`. Die Paketquelle der Installationen ist ebenfalls die
  npm-Registry (`YARN_REGISTRY` bzw. `YARN_NPM_REGISTRY_SERVER`), `registry.yarnpkg.com` und `repo.yarnpkg.com` bleiben
  gesperrt. Die Allowlist (`egressAllowList`) ist unverändert.
- Image: Das Live-Image `aideation-agent` hat Corepack 0.36.0 nur zufällig aus dem Playwright-Basis-Image
  (`/usr/bin/corepack`); Node ab 25 bringt kein Corepack mehr mit. Das Dockerfile installiert Corepack jetzt ausdrücklich
  (`corepack@0.36.0`, `ARG COREPACK_VERSION`). Bis zum nächsten Image-Bau funktioniert das vorhandene Corepack.

Nicht abgedeckt: Yarn ab 2 ohne `packageManager`-Feld und ohne `yarnPath` (Corepack nähme dann Yarn 1.x); Projekte
ohne `package.json` werden wie bisher nicht installiert.

### 3. Pausen-Race geschlossen (`src/runner/runner-selection.ts`, `src/runner/runner.ts`)

- Die projektweite Pause-Bedingung steht einmal als `projectPausedSql(alias)` und gilt an beiden Stellen: in der Auswahl
  (`selectItems`, wie bisher) und neu im Start-UPDATE jedes gewählten Auftrags (`runWorkItem`,
  `SET status = 'in_progress' … WHERE … NOT EXISTS (… retry_after > NOW())`). Setzt der erste Auftrag eines Takts die
  Pause, trifft das UPDATE des zweiten keine Zeile mehr; der Lauf wird verworfen, der Auftrag bleibt geplant
  (`skipped`, Log „nicht mehr eingeplant oder das Projekt pausiert“). Ein gezielt gestarteter Auftrag (`--item`) oder ein
  von Hand gestarteter Agent (`agent_id`) läuft weiterhin.

## Tests

- `src/runner/autofix.test.ts`: Installationsfehler aus `package.json`/Workspace (`edgesOut`, `EUNSUPPORTEDPROTOCOL
  workspace:`, `ERESOLVE`) sind kein Sandbox-Defekt; ein root-eigener Cache in der Installationsausgabe bleibt einer; ein
  nicht vorbereitbares Volume bleibt einer.
- `src/core/sandbox.test.ts`: Erkennung des Paketmanagers und Stempel je Manager; Installationsbefehle für pnpm, Yarn 1.x,
  Yarn ab 2 und npm; pnpm-Workspace mit gefaktem Docker: Installation mit `corepack pnpm install`, gescheiterte
  Installation blockiert den Befehl mit „Projekt-Abhängigkeiten: „pnpm install“ …“ ohne Badge-Eintrag.
- `src/runner/runner.test.ts`: Zwei gewählte Aufträge, der erste pausiert das Projekt (root-eigener Cache), der zweite
  startet im selben Takt nicht (`skipped`, Lauf gelöscht); beide Start-UPDATEs enthalten `NOT ${projectPausedSql('d')}`.

`npm run lint && npm run format:check && npm run typecheck && npm run test:unit` grün (siehe PR).

## Betrieb

Nicht deployt. Nach dem Merge: Worker neu starten; das Agent-Image beim nächsten Neustart neu bauen (Corepack fest im
Image). Blockierte pianotrainer-Aufträge mit Vermerk „Arbeitscontainer bzw. Sandbox defekt“ von Hand erneut starten.
