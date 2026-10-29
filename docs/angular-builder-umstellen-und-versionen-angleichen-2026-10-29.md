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
- **Noch offen:** `@angular/cdk` steht weiter auf 20.2.14. Die Lockfile wurde von Hand angepasst (oberster Eintrag), nicht von npm erzeugt. Sie enthält deshalb noch den Paketeintrag `node_modules/@angular-devkit/build-angular` samt Webpack-Kette. Die Audit-Funde sind also erst weg, wenn jemand mit npm-Freigabe `npm install -D @angular/cdk@^20.3.0` ausführt (erneuert die Lockfile und entfernt den alten Builder) und danach `npm ci`, `npm audit` und `npm audit --omit=dev` prüft. cdk wurde bewusst nicht von Hand angehoben, sonst bricht `npm ci` wegen unstimmiger Lockfile.
- Funde, die über `@modelcontextprotocol/sdk` aus `@angular/cli` kommen, behebt die Umstellung nicht.
- `npm ci` wurde im Auftrag nicht ausgeführt: `node_modules` im Worktree verweist auf den Hauptordner und wäre überschrieben worden.
- Der Bug-Wächter-Eintrag „monthly spend limit“ ist ein Abbruch der CLI wegen Ausgabenlimit, kein Codefehler. Der offene critical-Bug „CI: `npm run test:unit` schlägt fehl“ ist ein eigener Auftrag und hier nicht gelöst.
- Dependabot gruppiert `@angular/*` und `@angular-devkit/*` in einen Pull Request, damit Versionen nicht wieder auseinanderlaufen.

## Tests
Laut Entwickler: `npm run build:ui` und `typecheck` fehlerfrei, `lint` 0 Fehler (812 Warnungen, schon vorher vorhanden), `test:unit` 1822 bestanden. `ng serve` mit Proxy startet („Local: http://localhost:4299/“); die Seite wurde nicht abgerufen (`curl` gesperrt). Für diese Dokumentation wurden die Tests nicht erneut ausgeführt.

## Geänderte Dateien
- `.github/dependabot.yml` (neu)
- `angular.json`
- `package.json`
- `package-lock.json`
