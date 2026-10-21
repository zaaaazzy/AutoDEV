# Review-Container ohne echte DB-Zugänge und .env (21.10.2026)

Auftrag 33e97a13, Bugfix aus dem Code-Review vom 20.10.2026. Anleitung für Betrieb: `docs/laufzeit.md`, Abschnitt „Review-Container ohne echte Zugänge“.

## Problem

- Der Review-Container band den Projektordner samt `.env` ein. `aideation-review.sh` las daraus Haupt-DB-User und -Passwort und verband sich auch mit der DB `postgres`.
- Darin lief `npm ci` mit Lifecycle-Skripten aus Agent-Commits als root. Ein `postinstall` konnte `/source/.env` lesen (Admin-Passwort, Secret Key) oder Produktivdaten ändern.
- Das npm-Cache-Volume war für alle Projekte gemeinsam. Der Kommentar im Skript behauptete das Gegenteil des tatsächlichen Verhaltens.

## Umsetzung

- **Keine `.env`, kein Projektordner.** Gemountet werden nur die Git-Objekte schreibgeschützt unter `/source/objects`. Der Stand wird nach `/work` ausgecheckt. Alte Review-Befehle mit `/source/…` laufen weiter (`/source/` wird zu `/work/`). Für AIdeation selbst: `sh deploy/review/aideation-review.sh`.
- **Kein root.** `--user node`, `--cap-drop ALL`, `no-new-privileges`.
- **npm-Cache je Projekt:** Volume `aideation_review_npm_<projekt>`.
- **Eigener DB-User** über `DEV_LOG_REVIEW_DATABASE_URL`, ohne Superuser-Rechte. `scripts/setup-review-db.sh` legt User und Basis-Datenbank an und entzieht `PUBLIC` das `CONNECT` auf `aideation` und `postgres`. Die Isolation steckt in den Datenbankrechten, nicht in einer Textprüfung.
- **Kein Rückfall auf die Haupt-DB.** `reviewSlotDatabase` setzt den Slot auf „fehlgeschlagen“, wenn der Review-User fehlt oder dem Haupt-User gleicht. `containerEnvProblem` prüft das Env vor dem Start auf Haupt-User, Haupt-Passwort und die DB `postgres`. Docker-Ausgaben werden maskiert. Der Fehler ist ein fehlgeschlagener Schritt und löst keinen Autofix-Neustart aus.
- `aideation-review.sh` nutzt nur noch `REVIEW_DATABASE_URL`, der Kommentar stimmt jetzt mit dem Verhalten überein.

## Geänderte Dateien

- Code: `src/runner/review-slots.ts`, `src/runner/runner-cli.ts`
- Tests: `src/runner/review-slots.test.ts` (Negativtest auf Mounts und Env: keine `.env`, kein Haupt-DB-Passwort, keine DB `postgres`; Fehlerfall ohne Review-User)
- Container und Skripte: `deploy/review/aideation-review.sh`, `deploy/review/entrypoint.sh`, `deploy/review/Dockerfile`, `scripts/setup-review-db.sh`, `scripts/install-worker.sh`, `scripts/install-worker-linux.sh`
- Doku: `docs/laufzeit.md`, `README.md`

## Tests

`npm run typecheck` ist grün. `review-slots.test.ts` und `runner-cli.test.ts`: 16 von 16 bestanden. Der Entwickler meldete lokal die ganze Suite (877/877), Lint und `format:check` grün.

## Worauf zu achten ist

- **Vor dem Merge:** `scripts/setup-review-db.sh` ist im Git-Index nicht ausführbar (Modus 100644). `chmod +x` und `git update-index --chmod=+x scripts/setup-review-db.sh` sind noch zu tun. Das ging für Agents nicht.
- **Nach dem Merge:** `bash scripts/setup-review-db.sh` ausführen, den ausgegebenen Wert als `DEV_LOG_REVIEW_DATABASE_URL` setzen, den Worker neu installieren. Ohne diesen Wert starten keine Review-Container.
- **Projekte mit eigener Datenbank:** `reviewDatabase` setzt das Ziel noch mit den Zugangsdaten der Haupt-DB. `containerEnvProblem` blockiert das, der Slot schlägt also fehl, statt zu lecken. Der Pfad ist damit faktisch unbrauchbar. Richtig wäre eine Kopie, die dem Review-User gehört. Das ist offen und braucht einen eigenen Auftrag.
- **Nicht ausprobiert:** Ein echter Review-Container gegen eine echte Postgres-Instanz wurde nicht gestartet (Docker ist für Agents gesperrt). Bitte einmal mit gesetztem `DEV_LOG_REVIEW_DATABASE_URL` testen.
- **Abdeckung:** Für `runner-cli.ts` wurden nur etwa 29 % Zeilenabdeckung gemessen.
