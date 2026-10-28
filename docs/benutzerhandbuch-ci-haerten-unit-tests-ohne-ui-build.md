# Benutzerhandbuch: CI härten und Unit-Tests ohne Oberflächen-Build

Dieses Kapitel beschreibt, wann die CI (GitHub Actions) läuft, welche Rechte sie hat und welcher Testbefehl was tut. Es gilt für
das AIdeation-Repository. An der Dev-Log-Oberfläche ändert sich nichts. Die Änderung betrifft die Pipeline und die npm-Skripte.

## 1. Was sich ändert

- **Die CI läuft seltener doppelt.** Früher startete jeder Push auf einen Branch und zusätzlich der Pull Request dazu. Jetzt
  läuft die CI bei einem Push auf `main` und bei jedem Pull Request. Ein Push auf einen anderen Branch ohne Pull Request
  startet keine CI.
- **Alte Läufe werden abgebrochen.** Ein neuer Push auf denselben Pull Request bricht den noch laufenden Lauf ab. Läufe auf
  `main` werden nie abgebrochen.
- **Neues Skript `npm run test:unit`.** Es führt die Unit- und Integrationstests aus, ohne vorher die Oberfläche zu bauen.
- **`npm test` bleibt der Komplettlauf.** Es baut erst die Oberfläche (`build:ui`) und führt dann `test:unit` aus. Die Tests
  laufen mit denselben Dateimustern wie vorher.
- **Der Job `check` nutzt `test:unit`.** Die Oberfläche baut in der CI nur noch der Job `e2e`, weil nur die End-to-End-Tests
  `dist/ui` brauchen.

## 2. Bedingungen und Regeln

### Wann die CI läuft

| Auslöser | Läuft die CI? |
|---|---|
| Push auf `main` | Ja. Läufe auf `main` laufen immer zu Ende. |
| Pull Request öffnen oder neuen Commit pushen | Ja. Ein älterer Lauf desselben Pull Requests wird abgebrochen. |
| Push auf einen Branch ohne Pull Request | Nein. Erst der Pull Request startet die CI. |

### Testbefehle

| Befehl | Was er tut | Wann du ihn nimmst |
|---|---|---|
| `npm run test:unit` | Führt `src/**`, `scripts/**` und die Frontend-Specs aus. Baut die Oberfläche nicht. | Schneller Lauf während der Arbeit, in der CI und für Agents. |
| `npm test` | Erst `npm run build:ui`, dann `npm run test:unit`. | Vollständiger lokaler Lauf, wenn die Oberfläche selbst zählt. |
| `npm run test:e2e` | Oberflächentests (Playwright). Braucht vorher `npm run build:ui`. | Nur wenn du die Oberfläche geändert hast. |
| `npm run test:coverage` | Wie `test:unit` mit Abdeckungsbericht. Baut die Oberfläche nicht. | Wenn du die Abdeckung ansehen willst. |

- `test:unit` und `npm test` führen dieselben Tests aus. Der einzige Unterschied ist der Build der Oberfläche.
- Kein Unit-Test liest `dist/ui`. Deshalb kann `test:unit` ohne Build laufen.

### Rechte der CI

- Der Workflow hat nur Leserechte (`contents: read`). Kein Job schreibt ins Repository, in Issues oder in Pakete.
- Kein Job nutzt Secrets. Die Zugangsdaten im Dienst-Container der Datenbank sind Wegwerfwerte ohne Geheimnis.
- Das Zugriffstoken landet nicht in `.git/config` (`persist-credentials: false`). Der Projektcode kann es also nicht lesen.

### Agents und Rechte

- Agents dürfen `npm run test:unit` ausführen. Die Regel `npm run:*` deckt den Befehl ab, die Rechte-Regeln sind nicht
  verändert.
- Der Standard der Runner-Testbefehle (`npm run build` + `npm test`) bleibt unverändert, weil er für alle Projekte gilt.

## 3. Was du siehst

- **Im Tab „Actions“ von GitHub:** Die CI heißt „CI“. Die Jobs `check`, `e2e` und `docker` laufen nebeneinander.
- **Ein abgebrochener Lauf:** Er steht als „cancelled“. Das ist kein Fehler: Ein neuerer Push auf denselben Pull Request hat
  ihn ersetzt.
- **Ein Fehler in `check`:** Der Schritt „Run npm run test:unit“ zeigt die Testausgabe. Ein Fehler beim Bauen der Oberfläche
  kann hier nicht mehr auftreten, weil `check` nicht baut. Falls doch, liegt er im Job `e2e`.

## 4. Printscreens

Für dieses Kapitel gibt es keine Printscreens. Die Änderung wirkt nur in der Pipeline und in den npm-Skripten, nicht in der
Oberfläche von Dev Log. Diese Sitzung hat keinen laufenden Browser und keinen Zugang zu GitHub Actions. Die Beschreibung
stammt aus dem Quelltext (`.github/workflows/ci.yml`, `package.json`) und aus `docs/ci.md`. Die Tests habe ich in dieser
Sitzung nicht ausgeführt.

## 5. So prüfst du die Änderung

1. Lokal `npm run test:unit` ausführen. Der Lauf muss ohne Build der Oberfläche durchlaufen.
2. Lokal `npm test` ausführen. Der Lauf baut zuerst die Oberfläche und führt dann dieselben Tests aus.
3. Nach dem nächsten Pull Request im Tab „Actions“ prüfen, dass nur ein Lauf startet und `check` ohne Oberflächen-Build
   durchläuft.

## 6. Fehlerbehebung

| Zustand | Ursache | Was du tust |
|---|---|---|
| Der Lauf eines Pull Requests steht auf „cancelled“ | Ein neuer Push auf denselben Pull Request hat ihn ersetzt. | Nichts. Der neue Lauf zählt. |
| Auf einem Branch ohne Pull Request läuft keine CI | Gewollt: Die CI startet erst mit dem Pull Request. | Pull Request öffnen. |
| Lint meldet `src/runner/budget.test.ts:219` (`==` statt `===`) | Ein bestehender Fehler aus einem früheren Merge, nicht aus dieser Änderung. | Eigener Auftrag. Mit dieser Änderung ist er nicht zu beheben. |

## 7. Bekannte Lücken und offene Punkte

- **Actions noch nicht per SHA gepinnt.** `actions/checkout`, `actions/setup-node` und `actions/upload-artifact` stehen auf
  `@v4` (`ci.yml`). Die Commit-Nummern (SHA) ließen sich in der Agent-Umgebung nicht nachschlagen, sie wurden nicht geraten.
  Nachtragen mit `git ls-remote --tags https://github.com/actions/<name>`, dann `uses: actions/<name>@<sha> # v4.x.y`.
- **Projekteinstellung „Testbefehle“ für AIdeation.** Auf `npm run build` und `npm run test:unit` setzen (siehe
  [Installation](installation.md) und Abschnitt 2 oben). Sonst baut ein Agent-Lauf die Oberfläche zweimal. Ob das schon
  geschehen ist, ist nicht geprüft.
- **`docs/installation.md:105`** nennt bei „Testbefehle (Live schalten)“ noch `npm test`. Das betrifft das Standardbeispiel für
  Projekte, nicht AIdeation selbst. Es ist nicht angepasst.
- **YAML nicht geparst.** Die Datei `ci.yml` wurde nur gelesen. Ob die CI grün läuft, zeigt erst der nächste Lauf auf GitHub.
- **Tests vom Entwickler gemeldet.** „1622 Tests bestanden“ und „Typprüfung ohne Fehler“ stammen aus dem Lauf des Entwicklers.
  Ich habe nichts ausgeführt.
- **Nicht Teil dieses Kapitels:** Docker-Build und Typprüfung der Tests stehen im Auftrag „CI: E2E-Tests, Docker-Build und
  Typprüfung der Tests“.

## 8. Grenzen

- Das Kapitel beschreibt nur Auslöser, Rechte und Testbefehle der CI. Den Aufbau der Jobs `e2e` und `docker` steht in
  [CI (GitHub Actions)](ci.md).
- Die Änderung hat kein Datenbankschema und keine Migration.
