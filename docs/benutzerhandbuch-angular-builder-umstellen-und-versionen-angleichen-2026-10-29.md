# Benutzerhandbuch: Angular-Builder umstellen und Versionen angleichen

Dieses Kapitel beschreibt, was sich beim Entwickeln an AIdeation ändert: den Befehl `ng serve`, den Build der Oberfläche, die
Mindestversion von Node.js und die automatischen Abhängigkeits-Updates. Es gilt für das AIdeation-Repository. An der Oberfläche
von Dev Log ändert sich nichts. Auftrag 95b15d69, Stand 29.10.2026.

## 1. Was sich ändert

- **Der Entwicklungsserver heißt jetzt anders.** `npm run dev:ui` startet `ng serve` weiterhin mit dem Proxy aus
  `frontend/proxy.conf.json`. Dahinter steht jetzt der Builder `@angular/build:dev-server` statt `@angular-devkit/build-angular`.
  Der Aufruf bleibt gleich.
- **Der Build der Oberfläche läuft mit einem neuen Builder.** `npm run build:ui` nutzt `@angular/build:application`. Das
  Ausgabeverzeichnis `dist/ui` und die Build-Grenzen (Budgets) bleiben gleich.
- **Node.js 22.12 ist die Mindestversion, im Projekt festgeschrieben.** `package.json` enthält jetzt `"engines": {"node": ">=22.12"}`.
  Die Startskripte `start.sh` und `scripts/start.ps1` prüften schon vorher Node ≥ 22.12. Sie sind unverändert.
- **Eine Dev-Abhängigkeit ist ausgetauscht.** `@angular-devkit/build-angular` ist aus `package.json` entfernt, dafür steht
  `@angular/build` (^20.3.40) drin. Die Lockfile enthält den alten Eintrag noch (siehe Abschnitt 7).
- **Neue Datei `.github/dependabot.yml`.** GitHub öffnet wöchentlich Pull Requests für:
  - `npm`: alle `@angular/*`- und `@angular-devkit/*`-Pakete zusammen in einem Pull Request,
  - `docker`: `/`, `deploy/agent`, `deploy/frontend`, `deploy/review`, `deploy/worker`,
  - `github-actions`.

## 2. Bedingungen und Regeln

### Node.js-Version

| Node.js-Version | Was passiert |
|---|---|
| 22.12 oder neuer | Alles läuft. |
| 22.0 bis 22.11 | `start.sh` und `scripts/start.ps1` brechen sofort mit „Node.js … ist zu alt – bitte Version 22.12 oder neuer installieren“ ab. Ohne diese Prüfung scheiterte der Start erst spät in `npm ci`. |
| 21 oder älter | Wie oben: Abbruch mit Hinweis auf 22.12. |

Die Prüfung gilt beim Start über die Skripte. Ein direkter Aufruf von `npm ci` oder `npm run dev:ui` prüft die Version nur
über `engines`. npm meldet dann eine Warnung, bricht aber nur ab, wenn `engine-strict` gesetzt ist.

### Wann Abhängigkeiten neu installiert werden

- `start.sh` führt `npm ci` automatisch aus, wenn `node_modules` fehlt oder `package-lock.json` neuer ist als
  `node_modules/.package-lock.json`.
- `scripts/start.ps1` installiert nur, wenn `node_modules` fehlt. Nach einer Änderung an `package-lock.json` führst du
  `npm ci` selbst aus.

### Entwicklungsserver

| Befehl | Was er tut | Wann du ihn nimmst |
|---|---|---|
| `npm run dev:ui` | `ng serve` mit Proxy. Änderungen an der Oberfläche werden im Browser neu geladen. | Während du an der Oberfläche arbeitest. |
| `npm run build:ui` | Produktionsbuild nach `dist/ui`. | Vor dem Test der Oberfläche (`test:e2e`) oder vor dem Deployment. |

## 3. Was du siehst

- **Beim Start mit `./start.sh` oder `scripts/start.ps1`:** Bei zu alter Node-Version bricht das Skript mit der Meldung aus
  Abschnitt 2 ab, bevor etwas installiert wird. Ein Start mit korrekter Version sieht aus wie bisher.
- **Beim `npm run dev:ui`:** Die Konsole meldet `Local: http://localhost:<Port>/`. Der Entwickler hat den Start mit Port 4299
  geprüft. Ob die Seite dort lädt, ist nicht geprüft (siehe Abschnitt 7).
- **Auf GitHub im Tab „Pull requests“:** Wöchentlich erscheinen Pull Requests von Dependabot. Die Angular-Pakete kommen als ein
  gemeinsamer Pull Request, damit ihre Versionen nicht wieder auseinanderlaufen.

## 4. Printscreens

Für dieses Kapitel gibt es keine Printscreens. Die Änderung wirkt auf Build und Entwicklungsserver, nicht auf die Oberfläche
von Dev Log, und es gibt keine neue Bildschirmansicht, die man zeigen könnte. Die Sitzung hatte keinen Browser, mit dem die
Seite geöffnet und abfotografiert werden konnte. Die Beschreibung stammt aus `angular.json`, `package.json`, den Startskripten
und `.github/dependabot.yml`.

## 5. So prüfst du die Änderung

1. `npm ci` ausführen. Das muss ohne Fehler durchlaufen, auch mit Node 22.12 oder neuer.
2. `npm run build:ui` ausführen. Es muss ein Verzeichnis `dist/ui` entstehen.
3. `npm run typecheck`, `npm run lint` und `npm run test:unit` ausführen.
4. `npm audit` und `npm audit --omit=dev` ausführen. Mit `--omit=dev` muss das Ergebnis sauber sein.
5. `npm run dev:ui` starten und im Browser `http://localhost:<Port>/` öffnen. Die Seite muss laden und über den Proxy mit der API
   sprechen.
6. Die Mindestversion prüfen: Mit Node 22.11 oder älter brechen `./start.sh` und `scripts/start.ps1` mit dem Hinweis ab.

## 6. Fehlerbehebung

| Zustand | Ursache | Was du tust |
|---|---|---|
| „Node.js … ist zu alt“ beim Start | Installierte Node-Version liegt unter 22.12. | Node.js auf 22.12 oder neuer aktualisieren und das Skript erneut starten. |
| `npm ci` schlägt fehl, obwohl Node 22.12 oder neuer installiert ist | Nicht geprüft. Die Lockfile wurde von Hand angepasst und nicht von npm erzeugt, das ist der bekannte Schwachpunkt. | `npm ci` mit der Fehlermeldung melden. Siehe Abschnitt 7. |
| `ng serve` startet, die Seite lädt nicht | Nicht geprüft. Die Konsole zeigt den Grund, meist Proxy oder Port. | Die Konsole ansehen und `frontend/proxy.conf.json` prüfen. |
| `npm audit` zeigt noch Funde | Die Umstellung ist noch nicht vollständig (siehe Abschnitt 7). | Nicht als Fehler dieser Änderung werten, bis die offenen Punkte erledigt sind. |
| Ein Bug-Wächter-Eintrag meldet „monthly spend limit“ | Die Claude-CLI hat wegen ihres Ausgabenlimits abgebrochen. | Kein Code-Fehler. Den Lauf nach Erhöhung des Limits wiederholen. |

## 7. Offene Punkte

- **`@angular/cdk` steht noch auf 20.2.14.** Der Auftrag verlangt ^20.3.x. Der Entwickler hat cdk bewusst nicht von Hand
  angehoben, weil `npm ci` sonst mit einer unstimmigen Lockfile bricht.
- **Die Lockfile ist nicht von npm erzeugt.** Sie enthält noch den Paketeintrag `@angular-devkit/build-angular` mit der
  Webpack-Kette. Erst `npm install -D @angular/cdk@^20.3.0` mit npm-Freigabe erneuert sie vollständig.
- **Die `npm audit`-Funde sind nicht nachgeprüft.** Die 17 Funde aus dem Review bleiben bis zu diesem Schritt bestehen. Die Funde
  über `@modelcontextprotocol/sdk` aus `@angular/cli` behebt die Umstellung nicht.
- **Tests des Entwicklers:** `build:ui`, `typecheck` und `test:unit` (1822 Tests) laufen laut Entwickler grün, `lint` ohne
  Fehler (812 Warnungen, schon vorher vorhanden). `ng serve` startete. Die Seite wurde nicht abgerufen, weil `curl` in der
  Sitzung gesperrt war. Für dieses Kapitel wurden die Tests nicht erneut ausgeführt.
- **Nicht gelöst:** Der critical-Bug „CI: `npm run test:unit` schlägt fehl“ ist ein eigener Auftrag. Ob die Docker-Umstellung
  die Ursache ist, ist nicht geprüft. Die Node-Version in den Dockerfiles (`node:22.22.3`) entspricht dem Mindestwert.

## 8. Geänderte Dateien

- `angular.json`: Builder für `build` und `serve`.
- `package.json`: `engines`, `@angular/build` statt `@angular-devkit/build-angular`.
- `package-lock.json`: oberster Eintrag angeglichen, nicht von npm erzeugt.
- `.github/dependabot.yml`: neu.
- `docs/ci.md`: Abschnitt „Angular-Builder und Node-Version“.
