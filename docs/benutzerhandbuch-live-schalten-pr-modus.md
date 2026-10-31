# Benutzerhandbuch: Live schalten im PR-Modus

Dieses Kapitel beschreibt, wann ein Sprint im PR-Modus der GitHub-Brücke live geschaltet wird und was passiert, wenn der Projektordner nicht bereit ist. Auslöser ist der Bugfix 56c36360 (Code-Review vom 21.10.2026): Im PR-Modus konnte „Live schalten“ in zwei Ordner-Layouts ins Leere laufen. Mit eigenem Agent-Ordner wurde nie live geschaltet, ohne eigenen Agent-Ordner deployte der Projektordner den Sprint-Branch statt `main`.

> **Printscreens:** keine. In dieser Sitzung gab es keinen Browser und keine laufende App, daher sind keine Aufnahmen entstanden. Die Beschreibung stammt aus dem Quelltext (`src/runner/git-sync/sprint-reviews.ts`, Funktionen `tagMergedSprint` und `switchLiveFolderToMain`, Aufruf in `pollSprintReviews`) und aus den Tests in `src/runner/git-sync.test.ts` und `src/runner/github-sync.test.ts`. Für Aufnahmen müssten App, Datenbank, Worker und ein GitHub-Repository mit `gh`-Anmeldung laufen.

Die Oberfläche ändert sich nicht. Du siehst das Ergebnis im Sprint-Log und im Deploy-Status.

---

## 1. Was vorher passiert ist

Im PR-Modus (`issues+pr`) merged GitHub den Pull Request. Danach holt der Worker `main`, setzt den Sprint-Tag und zieht das lokale `main` nach. Nur wenn das gelingt, startet „Live schalten“ (Deploy und Eintrag in `production_deploys`). Zwei Ordner-Layouts haben dabei gefehlt:

- **Mit eigenem Agent-Ordner:** `main` ist im Projektordner (dem Live-Ordner) ausgecheckt, nicht im Agent-Ordner. Der Worker fand `main` im falschen Ordner, setzte den Stand auf „nicht aktualisiert“ und schaltete nie live. Dieser Teil war durch einen früheren Fix schon richtig; jetzt ist er durch Tests abgesichert.
- **Ohne eigenen Agent-Ordner:** Der Projektordner ist zugleich der Live-Ordner. Er blieb auf `sprint/…`. Der Befehl `fetch origin main:main` aktualisiert nur die Referenz, nicht den Ordner. Deployt wurde also der Sprint-Branch.

## 2. Was jetzt passiert

### 2.1 Ablauf nach dem Merge

1. Der Worker holt `main`, setzt den Tag `sprint-<Name>-<ID>` und pusht ihn.
2. Er zieht das lokale `main` nach. Liegt der Projektordner auf `main`, geschieht das wie bisher per Fast-Forward.
3. Ist der Projektordner der Live-Ordner und steht er auf dem Branch dieses Sprints, wechselt der Worker ihn auf `main`. Das passiert nur unter den Bedingungen in Abschnitt 3.
4. Nur wenn `main` jetzt aktuell ist, startet „Live schalten“: Deploy-Befehle und ein Eintrag in `production_deploys`.

Ist eine Bedingung nicht erfüllt, bleibt der Ordner unberührt. Es wird nicht deployt, und der Sprint-Log nennt den Grund.

### 2.2 Die Layouts im Vergleich

| Layout | Was der Worker tut | Ergebnis |
| --- | --- | --- |
| Eigener Agent-Ordner, `main` im Projektordner | Zieht `main` im Projektordner nach (bzw. setzt dort eine losgelöste Vorschau auf `main`) | Live schalten läuft, ein Eintrag in `production_deploys` |
| Kein eigener Agent-Ordner, Projektordner auf `sprint/…` | Wechselt den Projektordner auf `main` | Live schalten läuft, deployt wird `main` |
| Projektordner auf fremdem Branch | Nichts | Nicht live geschaltet, nicht deployt |
| Projektordner mit offenen Änderungen | Nichts | Nicht live geschaltet, nicht deployt, Änderungen bleiben |

## 3. Bedingungen

- **Wechsel auf `main`:** Nur wenn der Projektordner auf dem Branch dieses Sprints steht (`sprint/…` zum Startzeitpunkt) **und** keine offenen Änderungen an versionierten Dateien hat. Nicht versionierte Dateien stören nicht.
- **Kein Zwang:** Der Worker nutzt nie `--force` und verwirft keine Änderungen. Ein fremder Branch oder offene Änderungen bleiben unangetastet.
- **Deploy:** Nur bei `main` im aktuellen Stand. Ohne Aktualisierung von `main` gibt es keinen Deploy und keinen Eintrag in `production_deploys`.
- **Eintrag nur bei Deploy:** Ein Eintrag in `production_deploys` entsteht nur, wenn der Deploy tatsächlich läuft.
- **Sicherung bleibt:** Die Prüfung auf einen sauberen Live-Ordner (`liveFolderProblem`) bleibt bestehen und wurde nicht abgeschwächt.

## 4. Fehlerbehebung

| Beobachtung | Ursache und was zu tun ist |
| --- | --- |
| Im Sprint-Log: „Projektordner steht auf sprint/… statt auf main – nicht live geschaltet, dort „git switch main“.“ | Der Projektordner liegt auf einem anderen Branch als dem des Sprints (oder auf einem fremden Branch). Den Projektordner von Hand auf `main` stellen, dann „Live schalten“ erneut starten. |
| Im Sprint-Log: „Projektordner hat offene Änderungen auf sprint/… – nicht live geschaltet …“ | Im Projektordner liegen uncommittete Änderungen an versionierten Dateien. Sie committen oder verwerfen, dann `git switch main` ausführen. Danach „Live schalten“ erneut starten. |
| Im Sprint-Log: „Projektordner bleibt auf sprint/…: …“ | Der Wechsel auf `main` ist mit einem Git-Fehler gescheitert. Die Ausgabe zeigt die Ursache. Sie beheben und „Live schalten“ erneut starten. |
| „Live schalten“ ist fertig, aber der Deploy-Status zeigt „Nicht deployt“ | Der Projektordner ist nicht sauber auf `main`. Die Meldung im Sprint-Log nennt den Grund. |

## 5. Grenzen

- Der Worker wechselt den Projektordner nicht von einem fremden Branch auf `main`. Das ist beabsichtigt, weil dort Arbeit liegen kann. Der Mensch muss es selbst tun.
- Der Abschnitt gilt nur für den PR-Modus. Im Modus `aus` oder `issues` läuft die Git-Sicherung unverändert über Merge und Tag.
- Die Tests der Änderung laufen mit `npm test` ohne Abdeckungs-Flags. Der Entwickler hat sie laut Auftrag ausgeführt; diese Sitzung hat sie nicht erneut gestartet.

## Verweise

- [`workflows.md`](workflows.md), Abschnitt „GitHub-Brücke (`github_mode`)“ und „Sprint-Ablauf: vom Start bis Live“
- [`live-schalten-pr-modus-beide-layouts-2026-10-25.md`](live-schalten-pr-modus-beide-layouts-2026-10-25.md): Auftragsdoku mit Ursache und Tests
- [`benutzerhandbuch-sprint-branch-beim-start.md`](benutzerhandbuch-sprint-branch-beim-start.md): Sprint-Branch beim Start
- [`benutzerhandbuch-ci-spiegel-vor-pull-request.md`](benutzerhandbuch-ci-spiegel-vor-pull-request.md): CI-Spiegel, der vor dem Push im PR-Modus läuft (ein roter Schritt verhindert den Pull Request)
