# Angular-Builder umstellen und Versionen angleichen

Auftrag 95b15d69 aus dem Code-Review vom 21.10.2026 (Stand `a4971e9`). Stand: 29.10.2026. Sprint 28. Nur Build-Konfiguration, kein Anwendungscode, keine API- oder Datenbankänderung.

## Problem
`npm audit` meldete 17 Funde in der Dev-Toolchain (11 hoch), fast alle aus der Webpack-Kette von `@angular-devkit/build-angular`. `npm audit --omit=dev` war sauber, betroffen war also nur `ng serve` und der Build beim Entwickeln. Dazu kamen uneinheitliche Versionen (`@angular/cdk` fest auf 20.2.14, der Rest ^20.3) und ein fehlendes `engines`-Feld.

## Was umgesetzt wurde
- **Builder gewechselt** (`angular.json`): `build` nutzt `@angular/build:application`, `serve` nutzt `@angular/build:dev-server`. Die Optionen blieben unverändert.
- **Abhängigkeit getauscht** (`package.json`): `@angular-devkit/build-angular` ersetzt durch `@angular/build` (^20.3.40).
- **`engines`** (`package.json` und oberster Eintrag der `package-lock.json`): `"node": ">=22.12"`.
- **`.github/dependabot.yml`** (neu, optional im Auftrag): wöchentliche Updates für `npm` (Angular-Pakete als eine Gruppe), `docker` (`/`, `deploy/agent`, `deploy/frontend`, `deploy/review`, `deploy/worker`) und `github-actions`.
- **Unverändert:** `start.sh` und `scripts/start.ps1` prüfen bereits Node ≥ 22.12. Alle Dockerfiles nutzen `node:22.22.3`, das genügt.

## Worauf zu achten ist
- **Manueller Schritt für Patrick (kein Agent kann ihn ausführen):** `npm install`, `npm view`, `curl`, WebFetch und das Ausführen von Skripten per `npx` sind für Agents gesperrt. Ein Mensch muss `npm install -D @angular/cdk@^20.3.0` ausführen, danach `npm ci`, `npm run build:ui`, `npm run typecheck`, `npm run lint`, `npm run test:unit`, `npm audit` und `npm audit --omit=dev` und das Ergebnis festhalten. Den Auftrag nicht erneut an den Entwickler-Agent geben. Das von git ignorierte Hilfsskript `dist/prune-lock.mjs` im Arbeitsordner kann gelöscht werden.
- **Abnahme:** Der Tester hat den Auftrag nicht abgenommen. Die Lockfile ist nicht bereinigt und cdk nicht auf ^20.3.x, beides gehört zum Auftrag. Der Auftrag gilt erst nach dem manuellen Schritt als erledigt. Automatische Tests für die Akzeptanzkriterien gibt es nicht (reine Konfigurationsänderung); der Testlauf hat nur `typecheck` ausgeführt (bestanden).
- **Noch offen:** `@angular/cdk` steht weiter auf 20.2.14. Die Lockfile wurde von Hand angepasst (oberster Eintrag), nicht von npm erzeugt. Sie enthält deshalb noch den Paketeintrag `node_modules/@angular-devkit/build-angular` samt Webpack-Kette. Die Audit-Funde sind also erst weg, wenn jemand mit npm-Freigabe `npm install -D @angular/cdk@^20.3.0` ausführt (erneuert die Lockfile und entfernt den alten Builder) und danach `npm ci`, `npm audit` und `npm audit --omit=dev` prüft. cdk wurde bewusst nicht von Hand angehoben, sonst bricht `npm ci` wegen unstimmiger Lockfile.
- Funde, die über `@modelcontextprotocol/sdk` aus `@angular/cli` kommen, behebt die Umstellung nicht.
- `npm ci` wurde im Auftrag nicht ausgeführt: `node_modules` im Worktree verweist auf den Hauptordner und wäre überschrieben worden.
- Der Bug-Wächter-Eintrag „monthly spend limit“ ist ein Abbruch der CLI wegen Ausgabenlimit, kein Codefehler. Der offene critical-Bug „CI: `npm run test:unit` schlägt fehl“ ist ein eigener Auftrag und hier nicht gelöst.
- Dependabot gruppiert `@angular/*` und `@angular-devkit/*` in einen Pull Request, damit Versionen nicht wieder auseinanderlaufen.

## Stand beim erneuten Versuch (30.10.2026)
Der Entwickler-Agent hat nichts geändert, der Tester hat erneut nicht abgenommen (DoD 1: cdk ^20.3.x und bereinigte Lockfile fehlen). Der Testlauf (1b1b7eda) war auf 6 geänderte Dateien beschränkt. `npm run typecheck` schlug fehl: `tsc: not found`, Exit-Code 127 im Sandbox-Image „aideation-agent“ (fehlende Umgebung, kein Codefehler; `node_modules` liegt dort nicht vor). Der Schritt `npx tsx --test` wurde übersprungen, weil es keine passenden Tests gibt. Die Angabe „typecheck bestanden“ weiter oben stammt aus dem früheren Lauf. Geändert in diesem Versuch: `.github/dependabot.yml`, `docs/ci.md`, die beiden Doku-Dateien zum Auftrag, `package.json`, `package-lock.json`. Der Stand im Code: Builder in `angular.json:13` und `:88` umgestellt, `engines` gesetzt, `@angular/build` ^20.3.40 eingetragen. In `package.json` steht `@angular/cdk` weiter auf `20.2.14`. Es bleibt bei den Befehlen von Patrick (siehe „Worauf zu achten ist“). Danach: `grep build-angular package-lock.json` darf nichts mehr ausgeben, `dist/prune-lock.mjs` löschen, `package.json` und `package-lock.json` committen, Auftrag in der Vorschau freigeben. Nicht noch einmal an den Entwickler-Agent zurückgeben.

### Letzter Lauf (30.10.2026)
Der Entwickler-Agent hat in diesem Lauf nichts geändert. Alles ohne npm Machbare ist erledigt: Builder, `engines`, Startskripte (prüfen Node ≥ 22.12), `.nvmrc` und Dockerfile (22.22.3), `dependabot.yml`. In `package-lock.json` stehen weiter `@angular-devkit/build-angular`, `webpack` und `@modelcontextprotocol/sdk`; `@angular/cdk` steht auf 20.2.14. Beides lässt sich nur mit `npm install -D @angular/cdk@^20.3.0` auf dem Host beheben. Danach Tests und Audit laufen lassen, `dist/prune-lock.mjs` löschen (von git ignoriert), `package.json` und `package-lock.json` committen und den Auftrag in der Vorschau freigeben. Die Builds-Warnungen NG8113, NG8107 und 1.06 MB Start-Grösse (Schwelle 950 kB) sind nicht auf ihre Herkunft geprüft; der Build bricht deswegen nicht ab. Die Einträge „monthly spend limit“ im Bug-Verzeichnis sind keine Codefehler. In diesem Dokumentationslauf wurden keine Tests ausgeführt.

### Erneuter Lauf (30.10.2026, nach dem Hinweis zum erneuten Versuch)
Am Code hat sich nichts geändert. Der Hinweis verlangt `npm install`, `npm ls`, `npm audit`, `npm start`, `rm dist/prune-lock.mjs` und einen Commit. Im Agent-Container ist all das gesperrt: npm, `rm`, `sed` und `node -e` blockiert der Wächter. `git` geht nicht, weil der Worktree auf einen Host-Pfad zeigt (`/Volumes/DroneShots/...`). Die Lockfile von Hand zu bereinigen, ist keine Lösung: Gut 100 Webpack-Einträge müssten raus, und für cdk 20.3.x fehlen `resolved`/`integrity`, weil es kein Netz gibt. Danach wäre `npm ci` unsicher.

Für Patrick auf dem Host:
1. `npm install -D @angular/cdk@^20.3.0`. Bricht der Befehl mit `ETARGET` ab, gibt es keine cdk-Version 20.3.x. In dem Fall `npm install -D @angular/cdk@^20.2.14` ausführen und den Regex in `scripts/angular-builder.test.ts:44` auf `^\^20\.` lockern. Wichtig ist dann nur, dass die Version nicht mehr fest gepinnt ist.
2. `grep -c build-angular package-lock.json` muss 0 ergeben. Danach `npm ls @angular-devkit/build-angular webpack` (leer), `npm audit` und `npm audit --omit=dev` laufen lassen.
3. `npm ci && npm run build:ui && npm run typecheck && npm run lint && npm run test:unit`.
4. `rm dist/prune-lock.mjs`, dann `package.json` und `package-lock.json` committen und den Auftrag in der Vorschau freigeben.

Bis Schritt 1 erledigt ist, schlägt der Test „@angular/cdk steht auf 20.3.x“ in `scripts/angular-builder.test.ts` absichtlich fehl. Die übrigen vier Tests dort prüfen Builder, `engines` und die Startskripte und müssen grün sein. Der Abbruch des Testers (`EACCES` in `/home/agent/.npm/_cacache`) kommt aus dem Container und ist kein Codefehler.

### Dokumentationslauf nach dem Tester (30.10.2026)
Stand im Arbeitsordner geprüft: `package.json` hat `engines` (`>=22.12`) und `@angular/build` ^20.3.40, `@angular/cdk` steht weiter fest auf `20.2.14`. `package-lock.json` enthält `build-angular` noch 29-mal. Der Tester ist mit `EACCES` auf `/home/agent/.npm/_cacache` abgebrochen (Cache-Ordner gehört root, Umgebungsproblem des Containers, kein Codefehler); seine Dateiliste enthält auch `scripts/angular-builder.test.ts`, gelaufen ist davon nichts. Der Auftrag ist damit nicht abgenommen und bleibt offen, bis Patrick die Schritte im Abschnitt „Erneuter Lauf“ auf dem Host ausgeführt hat. Nicht erneut an Agents geben. Die Einträge „monthly spend limit“ sind keine Codefehler. Es wurden keine Tests ausgeführt.

## Tests
Laut Entwickler: `npm run build:ui` und `typecheck` fehlerfrei, `lint` 0 Fehler (812 Warnungen, schon vorher vorhanden), `test:unit` 1822 bestanden. `ng serve` mit Proxy startet („Local: http://localhost:4299/“); die Seite wurde nicht abgerufen (`curl` gesperrt). Für diese Dokumentation wurden die Tests nicht erneut ausgeführt.

## Geänderte Dateien
- `.github/dependabot.yml` (neu)
- `angular.json`
- `package.json`
- `package-lock.json`
