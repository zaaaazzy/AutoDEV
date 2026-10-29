# Angular-Builder umstellen und Versionen angleichen

Auftrag eabc9159 (Bugfix). Titel: „Bug: Bug-Wächter: Angular-Builder umstellen und Versionen angleichen“.

## Problem

- Der Bug-Text war nur die Spend-Limit-Meldung der Claude-CLI. Der Schritt „Bug-Wächter“ des Vorläufer-Auftrags hat nie gearbeitet.
- Die eigentliche Aufgabe: Die Oberfläche baute noch mit dem alten Wrapper `@angular-devkit/build-angular`. Seit Angular 17 ist `@angular/build` der direkte, empfohlene Builder (esbuild/Vite). Der alte Wrapper zieht zusätzlich Webpack und dessen Abhängigkeiten nach.

## Umsetzung

- `angular.json`: `build` nutzt `@angular/build:application`, `serve` nutzt `@angular/build:dev-server`. Optionen und Konfigurationen (`production`, `development`) sind unverändert. Ein `test`-Ziel gibt es nicht. Die Frontend-Specs laufen über `tsx --test` (`npm run test:unit`).
- `package.json`: `@angular-devkit/build-angular` ersetzt durch `@angular/build` `^20.3.40`. Das ist die Version, die schon als Abhängigkeit installiert war.
- `package-lock.json`: Nur der Wurzeleintrag (`packages[""].devDependencies`) ist von Hand angepasst. `node_modules/@angular/build` 20.3.40 war schon im Lock.

## Versionen

| Paket | Version | Bemerkung |
|---|---|---|
| `@angular/core`, `common`, `compiler`, `compiler-cli`, `forms`, `platform-browser` | 20.3.34 | einheitlich |
| `@angular/build`, `@angular/cli` | 20.3.40 | Tooling, eigene Patch-Reihe |
| `@angular/cdk` | 20.2.14 | CDK hat eigene Minor-Versionen; passt zu Angular 20 |
| `typescript` | ~5.9.3 | von Angular 20.3 unterstützt |

Es wurde keine Version angehoben. Alle Pakete liegen auf Angular 20 und passen zueinander.

## Offen

Agents dürfen kein `npm install` ausführen. Deshalb stehen die Einträge von `@angular-devkit/build-angular` und seinen eigenen Abhängigkeiten noch in `package-lock.json`. Sie werden von nichts mehr verlangt. `npm ci` installiert sie trotzdem, bis jemand einmal `npm install` ausführt und das Lock bereinigt.

## Prüfung

- Vor der Änderung: `npm run test:unit` lokal grün (1831/1831).
- Nach der Änderung: `npm run build` erfolgreich, mit den bisherigen Warnungen (NG8113, NG8107, Budget `initial` 1.06 MB über der Warnschwelle von 950 kB). `npm run test:unit` grün (1831/1831).
- `grep` nach `build-angular` außerhalb von `node_modules`, `dist` und `package-lock.json`: kein Treffer, auch nicht in Dockerfile, CI und Skripten.
